import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG, type WakeRules } from "./config.ts";
import { baselineKeys, decide, Ledger } from "./ledger.ts";
import type { CiReading, FailedCheck, PrReading } from "./reading.ts";
import { type Binding, MIGRATIONS, type PendingItem, Store } from "./store.ts";

const URL = "https://github.com/acme/api/pull/1";

const failedCheck = (name: string, required = true): FailedCheck => ({
  kind: "run",
  name,
  status: "COMPLETED",
  conclusion: "FAILURE",
  url: null,
  startedAt: null,
  required,
  workflow: "CI",
  key: `run:CI:${name}`,
});
const pass: CiReading = { kind: "settled", verdict: "pass", failed: [], optionalFailed: [] };
const failOn = (...names: string[]): CiReading => ({ kind: "settled", verdict: "fail", failed: names.map((name) => failedCheck(name)), optionalFailed: [] });
const fail = failOn("lint");

const reading = (ci: CiReading, sha = "abc", over: Partial<PrReading> = {}): PrReading => ({
  sha,
  ci,
  readiness: "not-ready",
  approved: false,
  approvalIds: [],
  approvers: [],
  queued: false,
  ...over,
});
const ready = (ids = ["r1"], over: Partial<PrReading> = {}) =>
  reading(pass, "abc", { readiness: "ready", approved: true, approvalIds: ids, approvers: ids.map((id) => `user-${id}`), ...over });

const item: PendingItem = {
  id: "c1",
  kind: "comment",
  author: "alice",
  reviewState: null,
  inlineCount: 0,
  at: "2026-11-04T10:00:00Z",
  url: `${URL}#c1`,
};

const rules = (over: Partial<WakeRules> = {}): WakeRules => ({ ...DEFAULT_CONFIG.wake, ...over });
const keys = (entries: Record<string, string> = {}) => new Map(Object.entries({ v: "2", ...entries }));
const last = (verdict: "pass" | "fail", sha = "old", failed: string[] = []) => JSON.stringify({ verdict, sha, failed });
const ciKind = (wake: ReturnType<typeof decide>) => wake?.ci?.kind ?? null;

test("the defaults: a pass wakes only after a failure, a failure every commit, and the merge wakes are on", () => {
  assert.deepEqual(DEFAULT_CONFIG.wake, {
    ciPassWakes: "after-failure",
    ciFailureWakes: "every-commit",
    readyWakes: true,
    draftWakes: true,
    queueWakes: true,
  });
});

test("decide: nothing settled, nothing pending and nothing new to say is no wake", () => {
  for (const ci of [{ kind: "none" }, { kind: "running" }, { kind: "unsupported" }] as const) {
    assert.equal(decide(reading(ci), keys(), [], rules()), null);
  }
});

test("decide: pending items wake on their own, with no keys to write", () => {
  assert.deepEqual(decide(reading({ kind: "running" }), keys(), [item], rules()), {
    ci: null,
    merge: [],
    items: [item],
    optionalFailed: [],
    changes: {},
  });
});

test("decide: a failure wakes, and records the commit and the failing checks", () => {
  assert.deepEqual(decide(reading(fail), keys(), [], rules()), {
    ci: { kind: "failed", sha: "abc", checks: fail.kind === "settled" ? fail.failed : [] },
    merge: [],
    items: [],
    optionalFailed: [],
    changes: { "ci:abc": "delivered:fail", last: last("fail", "abc", ["run:CI:lint"]) },
  });
});

test("decide: a pass with nothing told before wakes only when the setting asks for it", () => {
  assert.equal(decide(reading(pass), keys(), [], rules()), null, "after-failure, the default");
  assert.equal(ciKind(decide(reading(pass), keys(), [], rules({ ciPassWakes: "first-and-after-failure" }))), "passed");
  assert.equal(ciKind(decide(reading(pass), keys(), [], rules({ ciPassWakes: "every-commit" }))), "passed");
});

test("decide: a pass after a reported pass, on a new commit (a restack), wakes only for every-commit", () => {
  const told = keys({ last: last("pass") });
  assert.equal(decide(reading(pass, "new"), told, [], rules()), null);
  assert.equal(decide(reading(pass, "new"), told, [], rules({ ciPassWakes: "first-and-after-failure" })), null);
  assert.equal(ciKind(decide(reading(pass, "new"), told, [], rules({ ciPassWakes: "every-commit" }))), "passed");
});

test("decide: a pass after a reported failure is a recovery, on the same commit or a new one", () => {
  const sameCommit = decide(reading(pass), keys({ "ci:abc": "delivered:fail", last: last("fail", "abc") }), [], rules());
  assert.deepEqual(sameCommit?.ci, { kind: "recovered", sha: "abc" });
  assert.deepEqual(sameCommit?.changes, { "ci:abc": "delivered:pass", last: last("pass", "abc") });
  const newCommit = decide(reading(pass, "fix"), keys({ "ci:abc": "delivered:fail", last: last("fail", "abc") }), [], rules());
  assert.deepEqual(newCommit?.ci, { kind: "recovered", sha: "fix" });
});

test("decide: a reported commit stays reported, and a pass that turns into a failure on it stays silent", () => {
  assert.equal(decide(reading(fail), keys({ "ci:abc": "delivered:fail" }), [], rules()), null);
  assert.equal(decide(reading(pass), keys({ "ci:abc": "delivered:pass" }), [], rules()), null);
  assert.equal(decide(reading(fail), keys({ "ci:abc": "delivered:pass" }), [], rules()), null);
});

test("decide: a baselined verdict never reports on that commit, and a baseline isn't a told failure", () => {
  assert.equal(decide(reading(pass), keys({ "ci:abc": "baselined:fail" }), [], rules()), null);
  assert.equal(decide(reading(fail), keys({ "ci:abc": "baselined:pass" }), [], rules()), null);
  assert.equal(decide(reading(pass, "new"), keys({ "ci:abc": "baselined:fail" }), [], rules()), null);
});

test("decide: the same failure on a new commit wakes every commit, or only when the failing checks change", () => {
  const told = keys({ last: last("fail", "old", ["run:CI:lint"]) });
  assert.equal(ciKind(decide(reading(fail, "new"), told, [], rules())), "failed");
  const changed = rules({ ciFailureWakes: "changed-checks" });
  assert.equal(decide(reading(fail, "new"), told, [], changed), null);
  assert.equal(ciKind(decide(reading(failOn("lint", "tests"), "new"), told, [], changed)), "failed");
  assert.equal(ciKind(decide(reading(failOn("tests"), "new"), told, [], changed)), "failed");
});

test("decide: ready to merge wakes once for its approvals, with the approvers named", () => {
  const wake = decide(ready(["r2", "r1"]), keys(), [], rules());
  assert.deepEqual(wake?.merge, [{ kind: "ready", approvers: ["user-r2", "user-r1"] }]);
  assert.deepEqual(wake?.changes, { ready: JSON.stringify(["r2", "r1"]) });
  assert.equal(decide(ready(["r2", "r1"]), keys({ ready: JSON.stringify(["r2", "r1"]) }), [], rules()), null);
});

test("decide: a restack keeps the approvals, and another approval while ready stays silent", () => {
  const told = keys({ ready: JSON.stringify(["r1"]) });
  assert.equal(decide(ready(["r1"], { sha: "restacked" }), told, [], rules()), null);
  assert.equal(decide(ready(["r1", "r2"]), told, [], rules()), null);
});

test("decide: approvals dismissed and given again wake again", () => {
  assert.equal(decide(ready(["r3"]), keys({ ready: JSON.stringify(["r1"]) }), [], rules())?.merge[0]?.kind, "ready");
});

test("decide: an approval GitHub lists no review for still wakes once", () => {
  const wake = decide(ready([]), keys(), [], rules());
  assert.equal(wake?.merge[0]?.kind, "ready");
  assert.equal(decide(ready([]), keys(wake?.changes as Record<string, string>), [], rules()), null);
});

test("decide: no ready wake while queued, unknown, not ready, or turned off", () => {
  assert.equal(decide(ready(["r1"], { queued: true }), keys({ queued: "1" }), [], rules()), null);
  assert.equal(decide(ready(["r1"], { readiness: "unknown" }), keys(), [], rules()), null);
  assert.equal(decide(ready(["r1"], { readiness: "not-ready" }), keys(), [], rules()), null);
  assert.equal(decide(ready(["r1"]), keys(), [], rules({ readyWakes: false })), null);
});

test("decide: an approved, green draft wakes once, and can be turned off", () => {
  const draft = ready(["r1"], { readiness: "draft-approved" });
  const wake = decide(draft, keys(), [], rules());
  assert.deepEqual(wake?.merge, [{ kind: "draft-approved", approvers: ["user-r1"] }]);
  assert.equal(decide(draft, keys({ draft: JSON.stringify(["r1"]) }), [], rules()), null);
  assert.equal(decide(draft, keys(), [], rules({ draftWakes: false })), null);
});

test("decide: leaving the merge queue without merging wakes, unless turned off", () => {
  const wake = decide(reading({ kind: "running" }), keys({ queued: "1" }), [], rules());
  assert.deepEqual(wake?.merge, [{ kind: "left-queue" }]);
  assert.deepEqual(wake?.changes, { queued: null });
  assert.equal(decide(reading({ kind: "running" }), keys({ queued: "1" }), [], rules({ queueWakes: false })), null);
});

test("decide: failing checks that aren't required are listed only when something else wakes", () => {
  const ci: CiReading = { kind: "settled", verdict: "pass", failed: [], optionalFailed: [failedCheck("types", false)] };
  assert.equal(decide(reading(ci), keys(), [], rules()), null);
  assert.deepEqual(decide(reading(ci), keys(), [item], rules())?.optionalFailed, [failedCheck("types", false)]);
});

test("decide: a CI wake, a merge wake and feedback go out as one message", () => {
  const wake = decide(ready(["r1"]), keys({ "ci:abc": "delivered:fail", last: last("fail", "abc") }), [item], rules());
  assert.equal(wake?.ci?.kind, "recovered");
  assert.equal(wake?.merge[0]?.kind, "ready");
  assert.deepEqual(wake?.items, [item]);
});

test("baselineKeys: CI, readiness and the queue as they are when the watch starts", () => {
  assert.deepEqual(baselineKeys(ready(["r1"])), { v: "2", ready: '["r1"]', "ci:abc": "baselined:pass" });
  assert.deepEqual(baselineKeys(reading({ kind: "running" }, "abc", { queued: true })), { v: "2", queued: "1" });
  assert.deepEqual(baselineKeys(ready(["r1"], { readiness: "draft-approved" })), { v: "2", draft: '["r1"]', "ci:abc": "baselined:pass" });
});

function ledger(baseline: Record<string, string> = { v: "2" }): { store: Store; ledger: Ledger } {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const store = new Store(db);
  const binding: Binding = {
    prUrl: URL,
    environmentId: "env",
    hostId: "host",
    threadId: "thr",
    claimedBy: "agent",
    since: 0,
    branchBound: false,
    nextPollAt: 0,
    mayBeMissing: false,
    lastDeliveryAt: null,
    lastOutcome: null,
  };
  store.enroll(binding, { itemIds: [], keys: baseline });
  return { store, ledger: new Ledger(store, () => 5) };
}

test("Ledger: a watch from 0.1 takes its baseline on the first poll, so an approved PR doesn't wake", () => {
  const { store, ledger: subject } = ledger({});
  assert.equal(subject.next(URL, ready(["r1"]), rules()), null);
  assert.equal(store.keys(URL).get("v"), "2");
  assert.equal(store.keys(URL).get("ready"), '["r1"]');
});

test("Ledger: the merge queue is recorded as seen, and forgotten when its wake is off", () => {
  const { store, ledger: subject } = ledger();
  assert.equal(subject.next(URL, reading({ kind: "running" }, "abc", { queued: true }), rules()), null);
  assert.equal(store.keys(URL).get("queued"), "1");
  assert.equal(subject.next(URL, reading({ kind: "running" }), rules({ queueWakes: false })), null);
  assert.equal(store.keys(URL).has("queued"), false);
});

test("Ledger: a reserved wake isn't offered again, and a rolled-back one is", () => {
  const { store, ledger: subject } = ledger();
  store.recordNew(URL, { pending: [item], ignored: [], saturated: false });
  const wake = subject.next(URL, ready(["r1"]), rules());
  assert.ok(wake);
  const reservation = subject.reserve(URL, wake, 10);
  assert.equal(subject.next(URL, ready(["r1"]), rules()), null);
  subject.rollback(reservation);
  assert.deepEqual(subject.next(URL, ready(["r1"]), rules()), wake);
});

test("Ledger: a rolled-back recovery is a recovery again", () => {
  const { ledger: subject } = ledger();
  const failure = subject.next(URL, reading(fail), rules());
  assert.ok(failure);
  subject.reserve(URL, failure, 1);
  const recovery = subject.next(URL, reading(pass, "fix"), rules());
  assert.equal(recovery?.ci?.kind, "recovered");
  assert.ok(recovery);
  subject.rollback(subject.reserve(URL, recovery, 2));
  assert.equal(subject.next(URL, reading(pass, "fix"), rules())?.ci?.kind, "recovered");
});

test("Ledger: a change request clears 'ready', so the re-approval wakes even though an earlier approval survived", () => {
  const { ledger: subject } = ledger();
  const first = subject.next(URL, ready(["a"]), rules());
  assert.equal(first?.merge[0]?.kind, "ready");
  assert.ok(first);
  subject.reserve(URL, first, 1);
  assert.equal(subject.next(URL, ready(["a"], { readiness: "not-ready", approved: false }), rules()), null);
  assert.equal(subject.next(URL, ready(["a", "b2"]), rules())?.merge[0]?.kind, "ready");
});

test("Ledger: a restack that only drops CI or merge state keeps 'ready', so it stays quiet", () => {
  const { ledger: subject } = ledger();
  const first = subject.next(URL, ready(["a"]), rules());
  assert.ok(first);
  subject.reserve(URL, first, 1);
  assert.equal(subject.next(URL, ready(["a"], { readiness: "not-ready", ci: { kind: "running" } }), rules()), null);
  assert.equal(subject.next(URL, ready(["a"], { sha: "restacked" }), rules()), null);
});

test("decide: after a recovery on a later commit, a force-push back to the failed commit doesn't recover again", () => {
  const told = keys({ "ci:abc": "delivered:fail", "ci:fix": "delivered:pass", last: last("pass", "fix") });
  assert.equal(decide(reading(pass, "abc"), told, [], rules()), null);
});
