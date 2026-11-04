// What a PR's thread has already been told, and what it should be told next.
// The rules live in `decide`, which is pure; the Ledger keeps what was told as
// keys per PR, so every kind of wake is reserved and rolled back the same way.
//
// Keys:
//   ci:<sha>  "delivered:<verdict>" or "baselined:<verdict>" for a commit's CI
//   last      the last CI verdict the thread was told: {verdict, sha, failed}
//   ready     approval ids the thread was told "Ready to merge" for (JSON)
//   draft     approval ids the thread was told "Approved draft" for (JSON)
//   queued    "1" while the PR is seen in the merge queue or set to auto-merge
//   v         "2" once a watch has its 0.2 baseline
import type { WakeRules } from "./config.ts";
import type { Check } from "./contract.ts";
import type { PrReading, Verdict } from "./reading.ts";
import type { KeyChanges, PendingItem, Reservation, Store } from "./store.ts";

export type CiReport =
  | { kind: "failed"; sha: string; checks: Check[] }
  | { kind: "passed"; sha: string }
  | { kind: "recovered"; sha: string };

export type MergeEvent =
  | { kind: "ready"; approvers: string[] }
  | { kind: "draft-approved"; approvers: string[] }
  | { kind: "left-queue" };

/** One message's worth: what to say, and the keys that say it was said. */
export type Wake = {
  ci: CiReport | null;
  merge: MergeEvent[];
  items: PendingItem[];
  /** Failing checks that aren't required, listed only because something else woke. */
  optionalFailed: Check[];
  changes: KeyChanges;
};

const VERSION = "2";

type CiRow = { reason: "delivered" | "baselined"; verdict: Verdict };
type LastVerdict = { verdict: Verdict; sha: string; failed: string[] };

const ciKey = (sha: string) => `ci:${sha}`;

function parseCiRow(value: string | undefined): CiRow | null {
  const [reason, verdict] = (value ?? "").split(":");
  if ((reason === "delivered" || reason === "baselined") && (verdict === "pass" || verdict === "fail")) return { reason, verdict };
  return null;
}

function parseJson<T>(value: string | undefined, valid: (parsed: unknown) => parsed is T): T | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isLastVerdict = (value: unknown): value is LastVerdict => {
  const candidate = value as Partial<LastVerdict> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate.verdict === "pass" || candidate.verdict === "fail") &&
    typeof candidate.sha === "string" &&
    isStringList(candidate.failed)
  );
};

/** The approvals a "ready" key stands for. GitHub can approve with no listed review, so that has a stand-in id. */
const approvalSet = (reading: PrReading) => (reading.approvalIds.length > 0 ? reading.approvalIds : ["(approved)"]);

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((entry) => b.includes(entry));

/** Keys for what a watch takes as already known, so it reports only what changes after it starts. */
function stateKeys(reading: PrReading): Record<string, string> {
  const keys: Record<string, string> = { v: VERSION };
  if (reading.readiness === "ready" && !reading.queued) keys["ready"] = JSON.stringify(approvalSet(reading));
  if (reading.readiness === "draft-approved") keys["draft"] = JSON.stringify(approvalSet(reading));
  if (reading.queued) keys["queued"] = "1";
  return keys;
}

/** The baseline of a new watch: CI on the head commit, readiness and the merge queue. */
export function baselineKeys(reading: PrReading): Record<string, string> {
  const keys = stateKeys(reading);
  if (reading.ci.kind === "settled") keys[ciKey(reading.sha)] = `baselined:${reading.ci.verdict}`;
  return keys;
}

function told(reading: PrReading, report: CiReport, failed: string[]): KeyChanges {
  const verdict = report.kind === "failed" ? "fail" : "pass";
  return {
    [ciKey(reading.sha)]: `delivered:${verdict}`,
    last: JSON.stringify({ verdict, sha: reading.sha, failed } satisfies LastVerdict),
  };
}

function ciWake(reading: PrReading, keys: Map<string, string>, rules: WakeRules): { report: CiReport; changes: KeyChanges } | null {
  const { ci, sha } = reading;
  if (ci.kind !== "settled") return null;
  const row = parseCiRow(keys.get(ciKey(sha)));
  const last = parseJson(keys.get("last"), isLastVerdict);
  const failed = ci.failed.map((check) => check.key).sort();
  if (row) {
    // A commit already reported or baselined wakes again only to say a reported failure now passes.
    if (row.reason === "delivered" && row.verdict === "fail" && ci.verdict === "pass") {
      const report: CiReport = { kind: "recovered", sha };
      return { report, changes: told(reading, report, []) };
    }
    return null;
  }
  if (ci.verdict === "fail") {
    if (rules.ciFailureWakes === "changed-checks" && last?.verdict === "fail" && sameSet(last.failed, failed)) return null;
    const report: CiReport = { kind: "failed", sha, checks: ci.failed };
    return { report, changes: told(reading, report, failed) };
  }
  let report: CiReport | null = null;
  if (last?.verdict === "fail") report = { kind: "recovered", sha };
  else if (rules.ciPassWakes === "every-commit") report = { kind: "passed", sha };
  else if (rules.ciPassWakes === "first-and-after-failure" && !last) report = { kind: "passed", sha };
  return report && { report, changes: told(reading, report, []) };
}

function mergeWakes(reading: PrReading, keys: Map<string, string>, rules: WakeRules): { events: MergeEvent[]; changes: KeyChanges } {
  const events: MergeEvent[] = [];
  const changes: KeyChanges = {};
  const approvals = approvalSet(reading);
  // Wake again only for approvals the thread wasn't told about: a restack keeps them, a dismissal and re-approval doesn't.
  const isNew = (key: string) => !(parseJson(keys.get(key), isStringList) ?? []).some((id) => approvals.includes(id));
  if (rules.readyWakes && reading.readiness === "ready" && !reading.queued && isNew("ready")) {
    events.push({ kind: "ready", approvers: reading.approvers });
    changes["ready"] = JSON.stringify(approvals);
  }
  if (rules.draftWakes && reading.readiness === "draft-approved" && isNew("draft")) {
    events.push({ kind: "draft-approved", approvers: reading.approvers });
    changes["draft"] = JSON.stringify(approvals);
  }
  if (rules.queueWakes && keys.has("queued") && !reading.queued) {
    events.push({ kind: "left-queue" });
    changes["queued"] = null;
  }
  return { events, changes };
}

/** The next wake for a PR, or null when there is nothing new to tell. */
export function decide(
  reading: PrReading,
  keys: Map<string, string>,
  items: PendingItem[],
  rules: WakeRules,
): Wake | null {
  const ci = ciWake(reading, keys, rules);
  const merge = mergeWakes(reading, keys, rules);
  if (!ci && merge.events.length === 0 && items.length === 0) return null;
  const optionalFailed = reading.ci.kind === "settled" ? reading.ci.optionalFailed : [];
  return { ci: ci?.report ?? null, merge: merge.events, items, optionalFailed, changes: { ...ci?.changes, ...merge.changes } };
}

/**
 * Keys the ledger writes as it watches, with no wake: the 0.2 baseline of an older watch, the merge
 * queue, and forgetting "ready" once the PR stops being approved, so the next approval wakes even if
 * an earlier approval survived. CI running or a merge state dropping, as in a restack, keeps it.
 */
function observations(reading: PrReading, keys: Map<string, string>, rules: WakeRules): KeyChanges {
  if (keys.get("v") !== VERSION) return stateKeys(reading);
  const changes: KeyChanges = {};
  if (reading.queued && !keys.has("queued")) changes["queued"] = "1";
  if (!reading.queued && keys.has("queued") && !rules.queueWakes) changes["queued"] = null;
  if (!reading.approved) {
    if (keys.has("ready")) changes["ready"] = null;
    if (keys.has("draft")) changes["draft"] = null;
  }
  return changes;
}

export class Ledger {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  next(prUrl: string, reading: PrReading, rules: WakeRules): Wake | null {
    const seen = observations(reading, this.store.keys(prUrl), rules);
    if (Object.keys(seen).length > 0) this.store.setKeys(prUrl, seen, this.now());
    return decide(reading, this.store.keys(prUrl), this.store.pendingItems(prUrl), rules);
  }

  /** Records the wake as told before it is sent, in one transaction. */
  reserve(prUrl: string, wake: Wake, now: number): Reservation {
    return this.store.reserve(prUrl, wake.items.map((item) => item.id), wake.changes, now);
  }

  /** Undoes `reserve` for a send that is known not to have reached the thread. */
  rollback(reservation: Reservation): void {
    this.store.rollback(reservation);
  }
}
