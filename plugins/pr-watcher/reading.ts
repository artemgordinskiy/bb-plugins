// What a snapshot means for the plugin, worked out once per poll: the CI
// verdict from the newest run of each check, whether the PR is ready to
// merge, and whether it is queued. Pure, so every rule is tested on fixtures.
import type { Check, Snapshot } from "./contract.ts";

export type Verdict = "pass" | "fail";

/** What a failing check that isn't required does: wakes, only shows up in another wake, or nothing. */
export type OptionalFailures = "wake" | "mention" | "ignore";

export type FailedCheck = Check & { key: string };

export type CiReading =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "unsupported" }
  | { kind: "settled"; verdict: Verdict; failed: FailedCheck[]; optionalFailed: FailedCheck[] };

export type Readiness = "ready" | "draft-approved" | "not-ready" | "unknown";

export type PrReading = {
  sha: string;
  ci: CiReading;
  readiness: Readiness;
  /** Approved, whatever CI and the merge state say. */
  approved: boolean;
  /** Ids of the current approving reviews, sorted. */
  approvalIds: string[];
  approvers: string[];
  queued: boolean;
};

const FINE_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** A run that never gave a verdict. It counts only when the check is required. */
const VOID_CONCLUSIONS = new Set(["CANCELLED", "STALE"]);
/** Mergeable once approved: clean, clean with hooks, or only checks that aren't required failing. */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** One check across re-runs: the workflow or app plus its name. */
export const checkKey = (check: Check): string =>
  check.kind === "run" ? `run:${check.workflow ?? ""}:${check.name}` : `context:${check.name}`;

/** A run with no start time is queued, so it is newer than any run that started. */
const isNewer = (candidate: Check, current: Check) => {
  if (candidate.startedAt === null) return true;
  if (current.startedAt === null) return false;
  return candidate.startedAt > current.startedAt;
};

/** The newest run of each check. Older runs, including cancelled ones a re-run replaced, drop out. */
export function latestChecks(checks: Check[]): Check[] {
  const latest = new Map<string, Check>();
  for (const check of checks) {
    const key = checkKey(check);
    const current = latest.get(key);
    if (!current || isNewer(check, current)) latest.set(key, check);
  }
  return [...latest.values()];
}

const isUnfinished = (check: Check) =>
  check.kind === "run" ? check.status !== "COMPLETED" : check.status === "PENDING" || check.status === "EXPECTED";

function isFailed(check: Check): boolean {
  if (check.kind === "context") return check.status === "FAILURE" || check.status === "ERROR";
  const conclusion = check.conclusion ?? "";
  if (FINE_CONCLUSIONS.has(conclusion)) return false;
  return VOID_CONCLUSIONS.has(conclusion) ? check.required : true;
}

export function readCi(ci: Snapshot["ci"], optional: OptionalFailures = "wake"): CiReading {
  if (ci.hasNextPage) return { kind: "unsupported" };
  if (ci.checks.length === 0) return { kind: "none" };
  // With no rules on the base branch nothing is required, so every check counts as required.
  const anyRequired = ci.checks.some((check) => check.required);
  const latest = latestChecks(ci.checks).map((check) => (anyRequired ? check : { ...check, required: true }));
  if (latest.some(isUnfinished)) return { kind: "running" };
  // A required check that hasn't reported yet leaves the rollup pending without a listed check.
  if (ci.rollup === "PENDING" || ci.rollup === "EXPECTED") return { kind: "running" };
  const failures = latest.filter(isFailed).map((check) => ({ ...check, key: checkKey(check) }));
  const required = failures.filter((check) => check.required);
  const notRequired = failures.filter((check) => !check.required);
  if (optional === "wake") {
    return { kind: "settled", verdict: failures.length > 0 ? "fail" : "pass", failed: failures, optionalFailed: [] };
  }
  return {
    kind: "settled",
    verdict: required.length > 0 ? "fail" : "pass",
    failed: required,
    optionalFailed: optional === "mention" ? notRequired : [],
  };
}

function isApproved(snapshot: Snapshot, approvalIds: string[]): boolean {
  const changesRequested = snapshot.opinions.some((opinion) => opinion.state === "CHANGES_REQUESTED");
  // A base branch with no review rule has no decision; then an approval and no change request count.
  return snapshot.reviewDecision === "APPROVED" || (snapshot.reviewDecision === null && approvalIds.length > 0 && !changesRequested);
}

function readiness(snapshot: Snapshot, approved: boolean): Readiness {
  // Only required checks gate a merge, so a red check that isn't required never blocks "Ready to merge",
  // whatever the setting says about waking for it.
  const gate = readCi(snapshot.ci, "ignore");
  const ciOk = gate.kind === "none" || (gate.kind === "settled" && gate.verdict === "pass");
  if (!approved || !ciOk) return "not-ready";
  if (snapshot.isDraft) return "draft-approved";
  if (snapshot.mergeState === "UNKNOWN") return "unknown";
  return MERGEABLE_STATES.has(snapshot.mergeState) ? "ready" : "not-ready";
}

export function readPr(snapshot: Snapshot, optional: OptionalFailures = "wake"): PrReading {
  const ci = readCi(snapshot.ci, optional);
  const approvals = snapshot.opinions.filter((opinion) => opinion.state === "APPROVED");
  const approvalIds = approvals.map((opinion) => opinion.id).sort();
  const approved = isApproved(snapshot, approvalIds);
  return {
    sha: snapshot.headSha,
    ci,
    readiness: readiness(snapshot, approved),
    approved,
    approvalIds,
    approvers: approvals.map((opinion) => opinion.author),
    queued: snapshot.queued,
  };
}

export function ciLabel(ci: CiReading): string {
  if (ci.kind === "settled") return ci.verdict === "pass" ? "passing" : "failing";
  return ci.kind;
}

export function mergeLabel(reading: PrReading): string {
  if (reading.queued) return "queued";
  if (reading.readiness === "draft-approved") return "approved draft";
  return reading.readiness === "not-ready" ? "not ready" : reading.readiness;
}
