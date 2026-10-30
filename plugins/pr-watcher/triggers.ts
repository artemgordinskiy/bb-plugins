import { type Check, PAGE_SIZE, type Snapshot, type SnapshotItem } from "./contract.ts";
import type { PendingItem, ReportedSha, Verdict } from "./store.ts";

export const ACTIVE_POLL_MS = 60_000;
export const IDLE_POLL_MS = 5 * 60_000;
export const IDLE_WINDOW_MS = 10 * 60_000;

const FINE_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MEMBER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type CiState =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "unsupported" }
  | { kind: "settled"; verdict: Verdict; failed: Check[] };

export type CiReport =
  | { kind: "failed"; sha: string; checks: Check[] }
  | { kind: "passed"; sha: string }
  | { kind: "recovered"; sha: string };

const isUnfinished = (check: Check) =>
  check.kind === "run" ? check.status !== "COMPLETED" : check.status === "PENDING" || check.status === "EXPECTED";

const isFailed = (check: Check) =>
  check.kind === "run" ? !FINE_CONCLUSIONS.has(check.conclusion ?? "") : check.status === "FAILURE" || check.status === "ERROR";

export function readCi(ci: Snapshot["ci"]): CiState {
  if (ci.hasNextPage) return { kind: "unsupported" };
  if (ci.checks.length === 0) return { kind: "none" };
  if (ci.checks.some(isUnfinished)) return { kind: "running" };
  if (ci.rollup === "SUCCESS") return { kind: "settled", verdict: "pass", failed: [] };
  if (ci.rollup === "FAILURE" || ci.rollup === "ERROR") {
    return { kind: "settled", verdict: "fail", failed: ci.checks.filter(isFailed) };
  }
  return { kind: "running" };
}

/** What CI should report for this SHA, given what its row already says. */
export function ciReport(sha: string, ci: CiState, row: ReportedSha | null): CiReport | null {
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

export function nextPollDelay(ci: CiState, idleAt: number | null, now: number): number {
  const recentlyIdle = idleAt !== null && now - idleAt < IDLE_WINDOW_MS;
  return ci.kind === "running" || recentlyIdle ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}
