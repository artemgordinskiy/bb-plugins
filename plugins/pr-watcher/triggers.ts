import type { FeedbackRules } from "./config.ts";
import { PAGE_SIZE, type Snapshot, type SnapshotItem } from "./contract.ts";
import type { CiReading } from "./reading.ts";
import type { PendingItem } from "./store.ts";

export const ACTIVE_POLL_MS = 60_000;
export const IDLE_POLL_MS = 5 * 60_000;
export const IDLE_WINDOW_MS = 10 * 60_000;

export type PollTiming = { activePollMs: number; idlePollMs: number };

const DEFAULT_TIMING: PollTiming = { activePollMs: ACTIVE_POLL_MS, idlePollMs: IDLE_POLL_MS };

/** An approval with no inline comments and no text: "Ready to merge" covers it, unless bare approvals count. */
const isBareApproval = (item: SnapshotItem) =>
  item.kind === "review" && item.reviewState === "APPROVED" && item.inlineCount === 0 && item.excerpt.trim() === "";

export function isRelevant(item: SnapshotItem, viewerLogin: string, rules: FeedbackRules): boolean {
  if (item.author.toLowerCase() === viewerLogin.toLowerCase()) return false;
  if (item.kind === "review") {
    if (item.reviewState === "DISMISSED") return false;
    if (item.reviewState === "COMMENTED" && item.inlineCount === 0) return false;
    if (!rules.bareApprovals && isBareApproval(item)) return false;
  }
  if (item.authorIsBot) return item.kind === "review" && rules.bots.has(item.author.toLowerCase());
  return rules.roles.has(item.association.toUpperCase());
}

const toPending = (item: SnapshotItem): PendingItem => ({
  id: item.id,
  kind: item.kind,
  author: item.author,
  reviewState: item.reviewState ?? null,
  inlineCount: item.inlineCount,
  at: item.at,
  url: item.url,
});

export function classifyNew(snapshot: Pick<Snapshot, "viewerLogin" | "items">, known: Set<string>, rules: FeedbackRules) {
  const fresh = snapshot.items.filter((item) => !known.has(item.id));
  const saturatedKind = (kind: SnapshotItem["kind"]) =>
    fresh.filter((item) => item.kind === kind).length === PAGE_SIZE;
  const relevant = fresh.filter((item) => isRelevant(item, snapshot.viewerLogin, rules));
  const relevantIds = new Set(relevant.map((item) => item.id));
  return {
    pending: relevant.map(toPending),
    ignored: fresh.filter((item) => !relevantIds.has(item.id)).map((item) => item.id),
    saturated: saturatedKind("review") || saturatedKind("comment"),
  };
}

export function nextPollDelay(ci: CiReading, idleAt: number | null, now: number, timing: PollTiming = DEFAULT_TIMING): number {
  const recentlyIdle = idleAt !== null && now - idleAt < IDLE_WINDOW_MS;
  return ci.kind === "running" || recentlyIdle ? timing.activePollMs : timing.idlePollMs;
}
