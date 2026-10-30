import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PullRequestRef, Snapshot } from "./contract.ts";
import { buildMessage } from "./message.ts";
import { isEligible } from "./ownership.ts";
import type { Binding, PendingItem, Reservation, Store } from "./store.ts";
import { type CiReport, ciReport, readCi } from "./triggers.ts";

export const QUIET_MS = 120_000;

const BUSY = new Set(["active", "starting", "provisioning", "stopping", "waiting-for-host"]);

export type ThreadRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/** The checkout check. `moved` ends the watch; `unknown` holds it. */
export type CheckoutResult = "same" | "moved" | "unknown";

export type DeliveryContext = {
  bb: Pick<BbPluginApi, "sdk" | "log" | "pluginId">;
  store: Store;
  clock: WorkClock;
  now: () => number;
  instructionLine: string;
  /** Why a delivery is waiting, by PR URL. In memory: the next poll decides it again. */
  held: Map<string, string>;
  /** Ends the watch and everything kept for it. */
  end: (prUrl: string) => void;
};

export function isRunning(row: ThreadRow): boolean {
  if (row.archivedAt !== null || row.deletedAt !== null) return false;
  return BUSY.has(row.status) || BUSY.has(row.runtime.displayStatus);
}

/** The owner and everything reachable from it through parent and lifecycle-owner links. */
export function workSet(ownerId: string, rows: ThreadRow[]): ThreadRow[] {
  const children = new Map<string, ThreadRow[]>();
  for (const row of rows) {
    for (const link of [row.parentThreadId, row.lifecycleOwnerThreadId]) {
      if (link) children.set(link, [...(children.get(link) ?? []), row]);
    }
  }
  const found = new Map<string, ThreadRow>();
  const next = [ownerId];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    for (const child of children.get(id) ?? []) {
      if (found.has(child.id)) continue;
      found.set(child.id, child);
      next.push(child.id);
    }
  }
  return [...found.values()];
}

/** Last-running time per thread. Nothing is quiet until QUIET_MS after a restart. */
export class WorkClock {
  private readonly lastRunning = new Map<string, number>();
  private readonly startedAt: number;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  stamp(threadId: string, at: number): void {
    this.lastRunning.set(threadId, at);
  }

  quiet(threadIds: string[], now: number): boolean {
    if (now - this.startedAt < QUIET_MS) return false;
    return threadIds.every((id) => now - (this.lastRunning.get(id) ?? 0) >= QUIET_MS);
  }

  prune(now: number): void {
    for (const [id, at] of this.lastRunning) {
      if (now - at >= QUIET_MS) this.lastRunning.delete(id);
    }
  }
}

const isBusy = (owner: ThreadRow) =>
  isRunning(owner) ||
  owner.status === "pending" ||
  owner.hasPendingInteraction ||
  owner.queuedWork !== "none" ||
  Object.values(owner.activity).some((count) => count > 0);

/** Null when the owner can be woken, otherwise why not. */
export async function ownerHold(ctx: DeliveryContext, threadId: string): Promise<string | null> {
  const { bb, store, clock, now } = ctx;
  if (store.isOff(threadId)) return "thread off";
  const [owner] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
  if (!owner || !isEligible(owner)) return "owner not eligible";
  if (owner.status === "error") return "owner in error";
  if (isBusy(owner)) {
    clock.stamp(threadId, now());
    return "owner busy";
  }
  const inventory = await bb.sdk.threads.list({ projectId: owner.projectId, includeHidden: true, archived: false });
  for (const row of inventory.filter(isRunning)) clock.stamp(row.id, now());
  const work = workSet(threadId, inventory);
  if (work.some(isRunning)) return "work running";
  return clock.quiet([threadId, ...work.map((row) => row.id)], now()) ? null : "quiet time";
}

async function send(ctx: DeliveryContext, threadId: string, text: string, reservation: Reservation): Promise<void> {
  const { bb, store } = ctx;
  const { prUrl } = reservation;
  let result: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
  try {
    result = await bb.sdk.threads.send({
      threadId,
      input: [{ type: "text", text, mentions: [] }],
      mode: "start",
      originPluginId: bb.pluginId,
    });
  } catch (error) {
    bb.log.warn(`Send failed for ${prUrl} to ${threadId}; counting it as delivered: ${String(error)}`);
    store.setOutcome(prUrl, "unknown");
    return;
  }
  if (result.delivery === "sent") {
    store.setOutcome(prUrl, "sent");
    return;
  }
  try {
    await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: result.queuedMessage.id });
  } catch (error) {
    bb.log.warn(`Queued wake for ${prUrl} on ${threadId} could not be cancelled; counting it as delivered: ${String(error)}`);
    store.setOutcome(prUrl, "unknown");
    return;
  }
  store.rollback(reservation);
}

const ciReservation = (report: CiReport | null) =>
  report && { sha: report.sha, verdict: report.kind === "failed" ? ("fail" as const) : ("pass" as const), recovery: report.kind === "recovered" };

function compose(ctx: DeliveryContext, binding: Binding, pr: PullRequestRef, snapshot: Snapshot, report: CiReport | null, items: PendingItem[]) {
  return buildMessage({
    pr,
    url: binding.prUrl,
    title: snapshot.title,
    ci: report,
    items,
    excerpts: new Map(snapshot.items.map((item) => [item.id, item.excerpt])),
    mayBeMissing: binding.mayBeMissing,
    instructionLine: ctx.instructionLine,
  });
}

/** Runs inside the PR's queue, right after a poll, so it never acts on an old snapshot. */
export async function deliver(
  ctx: DeliveryContext,
  prUrl: string,
  pr: PullRequestRef,
  snapshot: Snapshot,
  checkout: () => Promise<CheckoutResult>,
): Promise<void> {
  const { store, held } = ctx;
  const binding = store.binding(prUrl);
  if (!binding) return;
  const items = store.pendingItems(prUrl);
  const report = ciReport(snapshot.headSha, readCi(snapshot.ci), store.reportedSha(prUrl, snapshot.headSha));
  if (items.length === 0 && !report) {
    held.delete(prUrl);
    return;
  }
  if (binding.branchBound) {
    const result = await checkout();
    if (result === "moved") {
      ctx.bb.log.info(`Checkout of ${binding.threadId} moved off ${prUrl}; ending the watch.`);
      ctx.end(prUrl);
      return;
    }
    if (result === "unknown") {
      held.set(prUrl, "checkout unresolved");
      return;
    }
  }
  const hold = await ownerHold(ctx, binding.threadId);
  if (hold) {
    held.set(prUrl, hold);
    return;
  }
  held.delete(prUrl);
  const text = compose(ctx, binding, pr, snapshot, report, items);
  const reservation = store.reserve(prUrl, items.map((item) => item.id), ciReservation(report), ctx.now());
  await send(ctx, binding.threadId, text, reservation);
}

/** Removes wakes left queued by an earlier run. It never re-arms anything. */
export async function startupSweep(ctx: DeliveryContext): Promise<void> {
  const { bb } = ctx;
  const rows = await bb.sdk.threads.queue.list();
  for (const row of rows.filter((entry) => entry.originPluginId === bb.pluginId)) {
    try {
      await bb.sdk.threads.queuedMessages.delete({ threadId: row.threadId, queuedMessageId: row.id });
    } catch (error) {
      bb.log.warn(`Leftover queued wake on ${row.threadId} could not be removed: ${String(error)}`);
    }
  }
}
