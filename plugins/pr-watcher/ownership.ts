// Who owns each watch, and every way that changes: a claim, a move of all of a
// thread's watches to another thread, a release, and a handoff to a parent
// when the owner goes away. Each change to a PR runs in that PR's queue.
// Outcomes are typed; server.ts turns them into tool and CLI text.
import type { Config } from "./config.ts";
import { parsePrUrl, type PullRequestRef, type Snapshot } from "./contract.ts";
import { baselineKeys } from "./ledger.ts";
import { type CiReading, readPr } from "./reading.ts";
import type { Binding, ClaimedBy, Store } from "./store.ts";
import { isRelevant, nextPollDelay } from "./triggers.ts";

export type ThreadFacts = {
  id: string;
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: string;
  originPluginId: string | null;
  parentThreadId: string | null;
  environmentId: string | null;
};

/** Forks by the user and child threads count; plugin-spawned threads don't. */
export function isEligible(thread: ThreadFacts): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.visibility === "visible" &&
    thread.originPluginId === null
  );
}

/** A URL claim is branch-bound only when it names the checkout's own PR. */
export function branchBound(hasUrl: boolean, url: string, checkoutUrl: string | null): boolean {
  return !hasUrl || url === checkoutUrl;
}

export function claimKind(existingOwner: string | null, threadId: string): "enroll" | "same" | "transfer" {
  if (existingOwner === null) return "enroll";
  return existingOwner === threadId ? "same" : "transfer";
}

/** The nearest eligible parent, if it is in the same environment. */
export async function findHandoff(
  owner: ThreadFacts,
  environmentId: string,
  load: (threadId: string) => Promise<ThreadFacts | null>,
): Promise<string | null> {
  const visited = new Set([owner.id]);
  let parentId = owner.parentThreadId;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = await load(parentId);
    if (!parent) return null;
    if (isEligible(parent)) return parent.environmentId === environmentId ? parent.id : null;
    parentId = parent.parentThreadId;
  }
  return null;
}

export type Environment = { ready: true; path: string; hostId: string } | { ready: false; reason: string };

export type ClaimOutcome =
  | { kind: "watching"; prUrl: string; number: number; ci: CiReading; earlier: number }
  | { kind: "replaced"; prUrl: string; previousThread: string; previousBy: ClaimedBy; pending: number }
  | { kind: "already"; prUrl: string }
  | { kind: "refused"; code: "invalid_pr" | "not_eligible" | "watching_off" | "no_pull_request" | "pr_closed" | "owner_changed" }
  | { kind: "unavailable"; reason: string };

export type MoveOutcome =
  | { kind: "moved"; results: { prUrl: string; outcome: ClaimOutcome }[] }
  | { kind: "refused"; code: "same_thread" | "not_eligible" };

/** Everything ownership needs from the outside, so tests and the server can supply it. */
export type OwnershipPorts = {
  store: Store;
  /** Runs a task in the PR's queue, after everything already queued for it. */
  queue: <T>(prUrl: string, task: () => Promise<T>) => Promise<T>;
  loadFacts: (threadId: string) => Promise<ThreadFacts | null>;
  readEnvironment: (environmentId: string) => Promise<Environment>;
  readCheckout: (path: string, hostId: string) => Promise<{ url: string | null } | { error: string }>;
  snapshot: (pr: PullRequestRef, hostId: string) => Promise<{ outcome: "snapshot"; snapshot: Snapshot } | { outcome: "failed"; message: string }>;
  config: () => Config;
  now: () => number;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Keeps the latest snapshot for status. */
  remember: (prUrl: string, snapshot: Snapshot) => void;
  /** Clears what was held for the previous owner. */
  forgetHeld: (prUrl: string) => void;
  /** Ends the watch and everything kept for it. */
  end: (prUrl: string) => void;
};

type Owner = Pick<Binding, "threadId" | "environmentId" | "hostId" | "claimedBy" | "branchBound">;

const LIST_LIMIT = 200;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Ownership {
  private readonly ports: OwnershipPorts;

  constructor(ports: OwnershipPorts) {
    this.ports = ports;
  }

  /** Makes `threadId` the owner of its checkout's PR, or of `url`. */
  async claim(threadId: string, claimedBy: ClaimedBy, url: string | undefined, expectedOwner?: string): Promise<ClaimOutcome> {
    try {
      return await this.tryClaim(threadId, claimedBy, url, expectedOwner);
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
  }

  /** Moves every watch `from` owns to `to`, keeping read positions and pending items. Turns nothing off. */
  async moveAll(from: string, to: string, claimedBy: ClaimedBy): Promise<MoveOutcome> {
    if (from === to) return { kind: "refused", code: "same_thread" };
    const target = await this.ports.loadFacts(to);
    if (!target || !isEligible(target)) return { kind: "refused", code: "not_eligible" };
    const results = [];
    for (const { prUrl } of this.ports.store.forThread(from)) {
      // Each move checks, in the PR's queue, that `from` still owns it: another claim can land while earlier moves wait.
      results.push({ prUrl, outcome: await this.claim(to, claimedBy, prUrl, from) });
    }
    return { kind: "moved", results };
  }

  /**
   * Ends one watch of the thread, or all of them. Ending all of them also turns
   * the thread off until `watch`, so its agent can't claim again.
   */
  async release(threadId: string, prUrl?: string): Promise<number> {
    const { store } = this.ports;
    if (prUrl === undefined) store.setOff(threadId, this.ports.now());
    const bindings = store.forThread(threadId).filter((binding) => prUrl === undefined || binding.prUrl === prUrl);
    await Promise.all(
      bindings.map(({ prUrl: url }) =>
        this.ports.queue(url, async () => {
          if (store.binding(url)?.threadId === threadId) this.ports.end(url);
        }),
      ),
    );
    return bindings.length;
  }

  /** Finishes a handoff that a failed read left open. Runs inside the PR's queue; a read that fails again is retried by the next poll. */
  async settle(binding: Binding): Promise<void> {
    const { prUrl, threadId } = binding;
    try {
      const owner = await this.ports.loadFacts(threadId);
      // threads.list leaves a deleted thread out, so its parents can't be walked.
      if (!owner) this.ports.end(prUrl);
      else if (owner.archivedAt !== null || owner.deletedAt !== null) await this.handOff(binding, owner);
    } catch (error) {
      this.ports.log.warn(`Owner check for ${prUrl} failed: ${describeError(error)}`);
    }
  }

  /** The owner was archived or deleted. A failed read keeps the watch, and the next poll tries again. */
  async ownerGone(owner: ThreadFacts): Promise<void> {
    const { store, queue, log } = this.ports;
    await Promise.all(
      store.forThread(owner.id).map(({ prUrl }) =>
        queue(prUrl, async () => {
          const binding = store.binding(prUrl);
          if (binding?.threadId === owner.id) await this.handOff(binding, owner);
        }).catch((error: unknown) => {
          log.error(`Owner handoff for ${prUrl} failed: ${describeError(error)}`);
        }),
      ),
    );
  }

  /** At startup: owners archived or deleted while the plugin was down. */
  async checkOwners(listThreads: (threadIds: string[]) => Promise<ThreadFacts[]>): Promise<void> {
    const { store, queue, log, end } = this.ports;
    const ids = [...new Set(store.bindings().map((binding) => binding.threadId))];
    for (let start = 0; start < ids.length; start += LIST_LIMIT) {
      const chunk = ids.slice(start, start + LIST_LIMIT);
      try {
        const rows = new Map((await listThreads(chunk)).map((row) => [row.id, row]));
        for (const id of chunk) {
          const row = rows.get(id);
          // threads.list leaves a deleted thread out, so its parents can't be walked.
          if (!row) await Promise.all(store.forThread(id).map(({ prUrl }) => queue(prUrl, async () => end(prUrl))));
          else if (row.archivedAt !== null || row.deletedAt !== null) await this.ownerGone(row);
        }
      } catch (error) {
        log.error(`Could not read owners at startup: ${describeError(error)}`);
      }
    }
  }

  /** Runs inside the PR's queue. A failed read throws and leaves the binding as it was. */
  private async handOff(binding: Binding, owner: ThreadFacts): Promise<void> {
    const { prUrl } = binding;
    const target = await findHandoff(owner, binding.environmentId, this.ports.loadFacts);
    if (target) {
      this.ports.log.info(`Handing ${prUrl} from ${owner.id} to ${target}.`);
      this.ports.store.moveOwner(prUrl, target);
      this.ports.forgetHeld(prUrl);
    } else {
      this.ports.log.info(`Owner ${owner.id} of ${prUrl} is gone; ending the watch.`);
      this.ports.end(prUrl);
    }
  }

  private async tryClaim(threadId: string, claimedBy: ClaimedBy, url: string | undefined, expectedOwner?: string): Promise<ClaimOutcome> {
    const { store } = this.ports;
    const named = url === undefined ? null : parsePrUrl(url);
    if (url !== undefined && !named) return { kind: "refused", code: "invalid_pr" };
    const thread = await this.ports.loadFacts(threadId);
    if (!thread || !isEligible(thread)) return { kind: "refused", code: "not_eligible" };
    if (claimedBy === "agent" && store.isOff(threadId)) return { kind: "refused", code: "watching_off" };
    if (claimedBy === "user") store.clearOff(threadId);
    const { environmentId } = thread;
    if (environmentId === null) return { kind: "unavailable", reason: "the thread has no environment" };
    const environment = await this.ports.readEnvironment(environmentId);
    if (!environment.ready) return { kind: "unavailable", reason: environment.reason };
    const { path, hostId } = environment;

    const checkout = await this.ports.readCheckout(path, hostId);
    if (named === null && "error" in checkout) return { kind: "unavailable", reason: checkout.error };
    const checkoutUrl = "url" in checkout ? checkout.url : null;
    if (named === null && checkoutUrl === null) return { kind: "refused", code: "no_pull_request" };
    const pr = named ?? parsePrUrl(checkoutUrl ?? "");
    if (!pr) return { kind: "refused", code: "no_pull_request" };

    const reply = await this.ports.snapshot(pr, hostId);
    if (reply.outcome === "failed") return { kind: "unavailable", reason: reply.message };
    const { snapshot } = reply;
    if (snapshot.state !== "OPEN") return { kind: "refused", code: "pr_closed" };

    const owner: Owner = { threadId, environmentId, hostId, claimedBy, branchBound: branchBound(url !== undefined, snapshot.url, checkoutUrl) };
    return this.ports.queue(snapshot.url, async (): Promise<ClaimOutcome> => {
      if (claimedBy === "agent" && store.isOff(threadId)) return { kind: "refused", code: "watching_off" };
      const existing = store.binding(snapshot.url);
      if (expectedOwner !== undefined && existing?.threadId !== expectedOwner) return { kind: "refused", code: "owner_changed" };
      const kind = claimKind(existing?.threadId ?? null, threadId);
      if (kind === "same") return { kind: "already", prUrl: snapshot.url };
      if (kind === "transfer" && existing) return this.transfer(existing, owner, snapshot);
      return this.enroll(owner, snapshot);
    });
  }

  private enroll(owner: Owner, snapshot: Snapshot): ClaimOutcome {
    const { store } = this.ports;
    const config = this.ports.config();
    const prUrl = snapshot.url;
    const now = this.ports.now();
    const reading = readPr(snapshot, config.optionalFailures);
    store.enroll(
      { ...owner, prUrl, since: now, nextPollAt: now + nextPollDelay(reading.ci, null, now, config), mayBeMissing: false, lastDeliveryAt: null, lastOutcome: null },
      { itemIds: snapshot.items.map((item) => item.id), keys: baselineKeys(reading) },
    );
    this.ports.remember(prUrl, snapshot);
    const earlier = snapshot.items.filter((item) => isRelevant(item, snapshot.viewerLogin, config.feedback)).length;
    return { kind: "watching", prUrl, number: parsePrUrl(prUrl)?.number ?? 0, ci: reading.ci, earlier };
  }

  /** Moves the owner and polling environment; what the PR's thread was told stays with the PR. */
  private transfer(previous: Binding, owner: Owner, snapshot: Snapshot): ClaimOutcome {
    const { store } = this.ports;
    const prUrl = previous.prUrl;
    const now = this.ports.now();
    store.transfer(prUrl, { ...owner, since: now, nextPollAt: now });
    this.ports.remember(prUrl, snapshot);
    this.ports.forgetHeld(prUrl);
    return { kind: "replaced", prUrl, previousThread: previous.threadId, previousBy: previous.claimedBy, pending: store.pendingItems(prUrl).length };
  }
}
