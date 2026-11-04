import { type Check, PAGE_SIZE, type Snapshot, type SnapshotItem } from "./contract.ts";
import type { CiReading } from "./reading.ts";
import type { PendingItem, ReportedSha } from "./store.ts";

export const ACTIVE_POLL_MS = 60_000;
export const IDLE_POLL_MS = 5 * 60_000;
export const IDLE_WINDOW_MS = 10 * 60_000;

const MEMBER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type CiReport =
  | { kind: "failed"; sha: string; checks: Check[] }
  | { kind: "passed"; sha: string }
  | { kind: "recovered"; sha: string };

/** What CI should report for this SHA, given what its row already says. */
export function ciReport(sha: string, ci: CiReading, row: ReportedSha | null): CiReport | null {
  if (ci.kind !== "settled") return null;
  if (!row) return ci.verdict === "pass" ? { kind: "passed", sha } : { kind: "failed", sha, checks: ci.failed };
  return row.reason === "delivered" && row.verdict === "fail" && ci.verdict === "pass" ? { kind: "recovered", sha } : null;
}

export function parseBotAuthors(setting: string): Set<string> {
  const logins = setting.split(",").map((login) => login.trim().toLowerCase().replace(/\[bot\]$/, ""));
  return new Set(logins.filter(Boolean));
}

export function isRelevant(item: SnapshotItem, viewerLogin: string, bots: Set<string>): boolean {
  if (item.author.toLowerCase() === viewerLogin.toLowerCase()) return false;
  if (item.kind === "review") {
    if (item.reviewState === "DISMISSED") return false;
    if (item.reviewState === "COMMENTED" && item.inlineCount === 0) return false;
  }
  if (item.authorIsBot) return item.kind === "review" && bots.has(item.author.toLowerCase());
  return MEMBER_ASSOCIATIONS.has(item.association);
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

export function classifyNew(snapshot: Pick<Snapshot, "viewerLogin" | "items">, known: Set<string>, bots: Set<string>) {
  const fresh = snapshot.items.filter((item) => !known.has(item.id));
  const saturatedKind = (kind: SnapshotItem["kind"]) =>
    fresh.filter((item) => item.kind === kind).length === PAGE_SIZE;
  const relevant = fresh.filter((item) => isRelevant(item, snapshot.viewerLogin, bots));
  const relevantIds = new Set(relevant.map((item) => item.id));
  return {
    pending: relevant.map(toPending),
    ignored: fresh.filter((item) => !relevantIds.has(item.id)).map((item) => item.id),
    saturated: saturatedKind("review") || saturatedKind("comment"),
  };
}

export function nextPollDelay(ci: CiReading, idleAt: number | null, now: number): number {
  const recentlyIdle = idleAt !== null && now - idleAt < IDLE_WINDOW_MS;
  return ci.kind === "running" || recentlyIdle ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}
