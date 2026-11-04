import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check, Snapshot } from "./contract.ts";
import { latestChecks, mergeLabel, readCi, readPr } from "./reading.ts";
import { snapshot } from "./test-support.ts";

const run = (name: string, over: Partial<Check> = {}): Check => ({
  kind: "run",
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: null,
  startedAt: "2026-11-04T10:00:00Z",
  required: false,
  workflow: "CI",
  ...over,
});
const failing = (name: string, over: Partial<Check> = {}) => run(name, { conclusion: "FAILURE", ...over });
const context = (name: string, state: string, required = false): Check => ({
  kind: "context",
  name,
  status: state,
  conclusion: null,
  url: null,
  startedAt: null,
  required,
  workflow: null,
});
const ci = (checks: Check[], rollup: Snapshot["ci"]["rollup"] = "SUCCESS", hasNextPage = false): Snapshot["ci"] => ({
  rollup,
  checks,
  hasNextPage,
});
const names = (checks: Check[]) => checks.map((check) => check.name);
const failedNames = (reading: ReturnType<typeof readCi>) => (reading.kind === "settled" ? names(reading.failed) : null);

test("readCi: no checks is no CI, and past 100 checks is unsupported", () => {
  assert.deepEqual(readCi(ci([], null)), { kind: "none" });
  assert.deepEqual(readCi(ci([failing("a")], "FAILURE", true)), { kind: "unsupported" });
});

test("readCi: an unfinished check, or a pending rollup, keeps CI running", () => {
  assert.deepEqual(readCi(ci([run("a", { status: "IN_PROGRESS", conclusion: null })], "FAILURE")), { kind: "running" });
  assert.deepEqual(readCi(ci([run("a"), context("b", "PENDING")])), { kind: "running" });
  assert.deepEqual(readCi(ci([run("a")], "PENDING")), { kind: "running" });
});

test("readCi: the verdict comes from the checks, not the rollup", () => {
  const reading = readCi(ci([run("a")], "FAILURE"));
  assert.ok(reading.kind === "settled" && reading.verdict === "pass");
});

test("readCi: fine conclusions pass; failures, timeouts and failed contexts fail", () => {
  const reading = readCi(
    ci([
      run("ok"),
      run("neutral", { conclusion: "NEUTRAL" }),
      run("skipped", { conclusion: "SKIPPED" }),
      failing("bad"),
      run("timed out", { conclusion: "TIMED_OUT" }),
      context("ctx ok", "SUCCESS"),
      context("ctx bad", "FAILURE"),
      context("ctx err", "ERROR"),
    ]),
  );
  assert.deepEqual(failedNames(reading), ["bad", "timed out", "ctx bad", "ctx err"]);
});

test("latestChecks: a re-run replaces the older run of the same check", () => {
  const older = failing("tests", { startedAt: "2026-11-04T10:00:00Z" });
  const newer = run("tests", { startedAt: "2026-11-04T10:05:00Z" });
  assert.deepEqual(latestChecks([older, newer]), [newer]);
  assert.deepEqual(latestChecks([newer, older]), [newer]);
});

test("readCi: cancelled runs that a newer run replaced don't fail CI (the #15356 case)", () => {
  const checks = ["checkmigrations", "checkschema", "ARM64 deployment image", "Find flags in PR diff"].flatMap((name) => [
    run(name, { conclusion: "CANCELLED", startedAt: "2026-11-03T14:22:55Z" }),
    run(name, { startedAt: "2026-11-03T14:22:56Z" }),
  ]);
  const reading = readCi(ci(checks, "FAILURE"));
  assert.ok(reading.kind === "settled" && reading.verdict === "pass");
});

test("readCi: two workflows with a job of the same name stay apart", () => {
  const reading = readCi(
    ci([
      failing("build", { workflow: "Backend", startedAt: "2026-11-04T10:00:00Z" }),
      run("build", { workflow: "Frontend", startedAt: "2026-11-04T10:05:00Z" }),
    ]),
  );
  assert.deepEqual(failedNames(reading), ["build"]);
});

test("readCi: a queued re-run with no start time is newer than a finished success, so CI runs", () => {
  const reading = readCi(ci([run("tests"), run("tests", { status: "QUEUED", conclusion: null, startedAt: null })]));
  assert.deepEqual(reading, { kind: "running" });
});

test("readCi: a cancelled run nothing replaced fails only when the check is required", () => {
  const optional = readCi(ci([run("required ok", { required: true }), run("lint", { conclusion: "CANCELLED" })]));
  assert.ok(optional.kind === "settled" && optional.verdict === "pass");
  const required = readCi(ci([run("tests", { conclusion: "CANCELLED", required: true })]));
  assert.deepEqual(failedNames(required), ["tests"]);
});

test("readCi: with no required checks at all, every check counts as required", () => {
  const reading = readCi(ci([run("tests", { conclusion: "CANCELLED" })]), "mention");
  assert.deepEqual(failedNames(reading), ["tests"]);
  assert.ok(reading.kind === "settled" && reading.failed[0]?.required === true);
});

test("readCi: a failing check that isn't required wakes, is only mentioned, or is ignored", () => {
  const checks = [run("tests", { required: true }), failing("frontend types")];
  const wake = readCi(ci(checks), "wake");
  assert.ok(wake.kind === "settled" && wake.verdict === "fail" && wake.failed[0]?.required === false);
  const mention = readCi(ci(checks), "mention");
  assert.ok(mention.kind === "settled" && mention.verdict === "pass");
  assert.deepEqual(names(mention.optionalFailed), ["frontend types"]);
  const ignore = readCi(ci(checks), "ignore");
  assert.ok(ignore.kind === "settled" && ignore.verdict === "pass" && ignore.optionalFailed.length === 0);
});

const green = ci([run("tests", { required: true })]);
const approval = (id: string, author = "alice") => ({ id, author, state: "APPROVED" as const });

test("readPr: approved, green and CLEAN is ready, with the approvals sorted", () => {
  const reading = readPr(
    snapshot({ ci: green, reviewDecision: "APPROVED", mergeState: "CLEAN", opinions: [approval("r2", "bob"), approval("r1")] }),
  );
  assert.equal(reading.readiness, "ready");
  assert.deepEqual(reading.approvalIds, ["r1", "r2"]);
  assert.deepEqual(reading.approvers, ["bob", "alice"]);
});

test("readPr: HAS_HOOKS and UNSTABLE are mergeable; BLOCKED, BEHIND and DIRTY aren't", () => {
  const state = (mergeState: string) =>
    readPr(snapshot({ ci: green, reviewDecision: "APPROVED", mergeState, opinions: [approval("r1")] })).readiness;
  assert.equal(state("HAS_HOOKS"), "ready");
  assert.equal(state("UNSTABLE"), "ready");
  for (const blocked of ["BLOCKED", "BEHIND", "DIRTY"]) assert.equal(state(blocked), "not-ready");
});

test("readPr: UNKNOWN is unknown, not ready and not a change", () => {
  const reading = readPr(snapshot({ ci: green, reviewDecision: "APPROVED", mergeState: "UNKNOWN", opinions: [approval("r1")] }));
  assert.equal(reading.readiness, "unknown");
});

test("readPr: not ready while CI runs or fails, or without approval", () => {
  const base = { reviewDecision: "APPROVED" as const, mergeState: "CLEAN", opinions: [approval("r1")] };
  assert.equal(readPr(snapshot({ ...base, ci: ci([run("a", { status: "IN_PROGRESS", conclusion: null })]) })).readiness, "not-ready");
  assert.equal(readPr(snapshot({ ...base, ci: ci([failing("a")]) })).readiness, "not-ready");
  assert.equal(readPr(snapshot({ ...base, ci: green, reviewDecision: "REVIEW_REQUIRED" })).readiness, "not-ready");
});

test("readPr: with no review rule, an approval and no change request count as approved", () => {
  const base = { ci: green, reviewDecision: null, mergeState: "CLEAN" };
  assert.equal(readPr(snapshot({ ...base, opinions: [approval("r1")] })).readiness, "ready");
  const blocked = readPr(snapshot({ ...base, opinions: [approval("r1"), { id: "r2", author: "bob", state: "CHANGES_REQUESTED" }] }));
  assert.equal(blocked.readiness, "not-ready");
  assert.equal(readPr(snapshot({ ...base, opinions: [] })).readiness, "not-ready");
});

test("readPr: an approved, green draft is an approved draft", () => {
  const reading = readPr(snapshot({ ci: green, isDraft: true, reviewDecision: "APPROVED", mergeState: "DRAFT", opinions: [approval("r1")] }));
  assert.equal(reading.readiness, "draft-approved");
  assert.equal(mergeLabel(reading), "approved draft");
});

test("readPr: a PR with no CI is ready once approved and clean", () => {
  const reading = readPr(snapshot({ ci: ci([], null), reviewDecision: "APPROVED", mergeState: "CLEAN", opinions: [approval("r1")] }));
  assert.equal(reading.readiness, "ready");
});

test("mergeLabel: queued wins over readiness", () => {
  const reading = readPr(snapshot({ ci: green, reviewDecision: "APPROVED", mergeState: "CLEAN", opinions: [approval("r1")], queued: true }));
  assert.equal(mergeLabel(reading), "queued");
});

test("readPr: a red check that isn't required doesn't block ready to merge, whatever the setting", () => {
  const ci = { rollup: "FAILURE" as const, hasNextPage: false, checks: [run("tests", { required: true }), failing("claude")] };
  for (const optional of ["wake", "mention", "ignore"] as const) {
    const reading = readPr(snapshot({ ci, reviewDecision: "APPROVED", mergeState: "UNSTABLE", opinions: [approval("r1")] }), optional);
    assert.equal(reading.readiness, "ready", optional);
  }
});

test("readPr: approved says whether the PR is approved, apart from CI and merge state", () => {
  const running = ci([run("a", { status: "IN_PROGRESS", conclusion: null })]);
  assert.equal(readPr(snapshot({ ci: running, reviewDecision: "APPROVED", opinions: [approval("r1")] })).approved, true);
  assert.equal(readPr(snapshot({ ci: green, reviewDecision: "CHANGES_REQUESTED", opinions: [approval("r1")] })).approved, false);
});
