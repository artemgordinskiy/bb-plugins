// What a PR's thread has already been told, and what it should be told next.
// The rules live in `decide`, which is pure; the Ledger keeps what was told as
// keys per PR, so every kind of wake is reserved and rolled back the same way.
import type { Check } from "./contract.ts";
import type { PrReading, Verdict } from "./reading.ts";
import type { KeyChanges, PendingItem, Reservation, Store } from "./store.ts";

export type CiReport =
  | { kind: "failed"; sha: string; checks: Check[] }
  | { kind: "passed"; sha: string }
  | { kind: "recovered"; sha: string };

/** One message's worth: what to say, and the keys that say it was said. */
export type Wake = {
  ci: CiReport | null;
  items: PendingItem[];
  changes: KeyChanges;
};

type CiRow = { reason: "delivered" | "baselined"; verdict: Verdict };

const ciKey = (sha: string) => `ci:${sha}`;

function parseCiRow(value: string | undefined): CiRow | null {
  const [reason, verdict] = (value ?? "").split(":");
  if ((reason === "delivered" || reason === "baselined") && (verdict === "pass" || verdict === "fail")) return { reason, verdict };
  return null;
}

/** What a new watch takes as already known, so it reports only what changes after it starts. */
export function baselineKeys(reading: PrReading): Record<string, string> {
  return reading.ci.kind === "settled" ? { [ciKey(reading.sha)]: `baselined:${reading.ci.verdict}` } : {};
}

function ciWake(reading: PrReading, keys: Map<string, string>): { report: CiReport; changes: KeyChanges } | null {
  const { ci, sha } = reading;
  if (ci.kind !== "settled") return null;
  const row = parseCiRow(keys.get(ciKey(sha)));
  if (!row) {
    const report: CiReport = ci.verdict === "pass" ? { kind: "passed", sha } : { kind: "failed", sha, checks: ci.failed };
    return { report, changes: { [ciKey(sha)]: `delivered:${ci.verdict}` } };
  }
  if (row.reason === "delivered" && row.verdict === "fail" && ci.verdict === "pass") {
    return { report: { kind: "recovered", sha }, changes: { [ciKey(sha)]: "delivered:pass" } };
  }
  return null;
}

/** The next wake for a PR, or null when there is nothing new to tell. */
export function decide(reading: PrReading, keys: Map<string, string>, items: PendingItem[]): Wake | null {
  const ci = ciWake(reading, keys);
  if (!ci && items.length === 0) return null;
  return { ci: ci?.report ?? null, items, changes: { ...ci?.changes } };
}

export class Ledger {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  next(prUrl: string, reading: PrReading): Wake | null {
    return decide(reading, this.store.keys(prUrl), this.store.pendingItems(prUrl));
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
