import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { baselineKeys, decide, Ledger } from "./ledger.ts";
import type { CiReading, FailedCheck, PrReading } from "./reading.ts";
import { type Binding, MIGRATIONS, type PendingItem, Store } from "./store.ts";

const URL = "https://github.com/acme/api/pull/1";

const failedCheck: FailedCheck = {
  kind: "run",
  name: "lint",
  status: "COMPLETED",
  conclusion: "FAILURE",
  url: null,
  startedAt: null,
  required: true,
  workflow: "CI",
  key: "run:CI:lint",
};
const pass: CiReading = { kind: "settled", verdict: "pass", failed: [], optionalFailed: [] };
const fail: CiReading = { kind: "settled", verdict: "fail", failed: [failedCheck], optionalFailed: [] };

const reading = (ci: CiReading, sha = "abc", over: Partial<PrReading> = {}): PrReading => ({
  sha,
  ci,
  readiness: "not-ready",
  approvalIds: [],
  approvers: [],
  queued: false,
  ...over,
});

const item: PendingItem = {
  id: "c1",
  kind: "comment",
  author: "alice",
  reviewState: null,
  inlineCount: 0,
  at: "2026-11-04T10:00:00Z",
  url: `${URL}#c1`,
};

const keys = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

test("decide: nothing settled and nothing pending is no wake", () => {
  for (const ci of [{ kind: "none" }, { kind: "running" }, { kind: "unsupported" }] as const) {
    assert.equal(decide(reading(ci), keys(), []), null);
  }
});

test("decide: pending items wake on their own, with no keys to write", () => {
  assert.deepEqual(decide(reading({ kind: "running" }), keys(), [item]), { ci: null, items: [item], changes: {} });
});

test("decide: the first verdict on a SHA reports and writes its key", () => {
  assert.deepEqual(decide(reading(fail), keys(), []), {
    ci: { kind: "failed", sha: "abc", checks: [failedCheck] },
    items: [],
    changes: { "ci:abc": "delivered:fail" },
  });
  assert.deepEqual(decide(reading(pass), keys(), [])?.ci, { kind: "passed", sha: "abc" });
});

test("decide: a reported SHA stays reported", () => {
  assert.equal(decide(reading(fail), keys({ "ci:abc": "delivered:fail" }), []), null);
  assert.equal(decide(reading(pass), keys({ "ci:abc": "delivered:pass" }), []), null);
  assert.equal(decide(reading(fail), keys({ "ci:abc": "delivered:pass" }), []), null, "a pass that turns to a failure stays silent");
});

test("decide: a delivered failure that passes on the same SHA is one recovery", () => {
  assert.deepEqual(decide(reading(pass), keys({ "ci:abc": "delivered:fail" }), []), {
    ci: { kind: "recovered", sha: "abc" },
    items: [],
    changes: { "ci:abc": "delivered:pass" },
  });
});

test("decide: a baselined verdict never reports on that SHA", () => {
  assert.equal(decide(reading(pass), keys({ "ci:abc": "baselined:fail" }), []), null);
  assert.equal(decide(reading(fail), keys({ "ci:abc": "baselined:pass" }), []), null);
});

test("baselineKeys: a settled verdict is baselined; anything else isn't", () => {
  assert.deepEqual(baselineKeys(reading(fail)), { "ci:abc": "baselined:fail" });
  assert.deepEqual(baselineKeys(reading({ kind: "running" })), {});
});

function ledger(): { store: Store; ledger: Ledger } {
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
  store.enroll(binding, { itemIds: [], keys: {} });
  return { store, ledger: new Ledger(store) };
}

test("Ledger: a reserved wake isn't offered again, and a rolled-back one is", () => {
  const { store, ledger: subject } = ledger();
  store.recordNew(URL, { pending: [item], ignored: [], saturated: false });
  const wake = subject.next(URL, reading(fail));
  assert.ok(wake);
  const reservation = subject.reserve(URL, wake, 10);
  assert.equal(subject.next(URL, reading(fail)), null);
  subject.rollback(reservation);
  assert.deepEqual(subject.next(URL, reading(fail)), wake);
});

test("Ledger: a rolled-back recovery is a recovery again", () => {
  const { ledger: subject } = ledger();
  const failure = subject.next(URL, reading(fail));
  assert.ok(failure);
  subject.reserve(URL, failure, 1);
  const recovery = subject.next(URL, reading(pass));
  assert.equal(recovery?.ci?.kind, "recovered");
  assert.ok(recovery);
  subject.rollback(subject.reserve(URL, recovery, 2));
  assert.equal(subject.next(URL, reading(pass))?.ci?.kind, "recovered");
});
