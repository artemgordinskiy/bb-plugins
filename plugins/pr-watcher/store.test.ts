import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { type Binding, MIGRATIONS, type PendingItem, Store } from "./store.ts";

const URL_A = "https://github.com/acme/api/pull/1";
const URL_B = "https://github.com/acme/api/pull/2";

function open(): Store {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return new Store(db);
}

const binding = (over: Partial<Binding> = {}): Binding => ({
  prUrl: URL_A,
  environmentId: "env_1",
  hostId: "host_1",
  threadId: "thr_a",
  claimedBy: "agent",
  since: 100,
  branchBound: true,
  nextPollAt: 200,
  mayBeMissing: false,
  lastDeliveryAt: null,
  lastOutcome: null,
  ...over,
});

const pending = (id: string): PendingItem => ({
  id,
  kind: "review",
  author: "alice",
  reviewState: "APPROVED",
  inlineCount: 0,
  at: "2026-10-30T10:00:00Z",
  url: `${URL_A}#${id}`,
});

const enroll = (store: Store, over: Partial<Binding> = {}) =>
  store.enroll(binding(over), { itemIds: [], ci: null });

test("enroll baselines items and a settled SHA with the binding", () => {
  const store = open();
  store.enroll(binding(), { itemIds: ["a", "b"], ci: { sha: "abc", verdict: "fail" } });
  assert.deepEqual([...store.knownIds(URL_A)].sort(), ["a", "b"]);
  assert.deepEqual(store.reportedSha(URL_A, "abc"), { reason: "baselined", verdict: "fail" });
  assert.equal(store.binding(URL_A)?.branchBound, true);
});

test("recordNew stores pending and seen together and sets the flag", () => {
  const store = open();
  enroll(store);
  store.recordNew(URL_A, { pending: [pending("p")], ignored: ["i"], saturated: true });
  assert.deepEqual([...store.knownIds(URL_A)].sort(), ["i", "p"]);
  assert.deepEqual(store.pendingItems(URL_A), [pending("p")]);
  assert.equal(store.binding(URL_A)?.mayBeMissing, true);
});

test("recordNew leaves an earlier flag set", () => {
  const store = open();
  enroll(store);
  store.recordNew(URL_A, { pending: [], ignored: [], saturated: true });
  store.recordNew(URL_A, { pending: [], ignored: [], saturated: false });
  assert.equal(store.binding(URL_A)?.mayBeMissing, true);
});

test("reserve moves items to seen, records the SHA and marks sending in one step", () => {
  const store = open();
  enroll(store);
  store.recordNew(URL_A, { pending: [pending("p")], ignored: [], saturated: true });
  store.reserve(URL_A, ["p"], { sha: "abc", verdict: "fail", recovery: false }, 500);
  assert.deepEqual(store.pendingItems(URL_A), []);
  assert.ok(store.knownIds(URL_A).has("p"));
  assert.deepEqual(store.reportedSha(URL_A, "abc"), { reason: "delivered", verdict: "fail" });
  const row = store.binding(URL_A);
  assert.equal(row?.lastOutcome, "sending");
  assert.equal(row?.lastDeliveryAt, 500);
  assert.equal(row?.mayBeMissing, false);
});

test("reserve for a recovery flips the row", () => {
  const store = open();
  enroll(store);
  store.reserve(URL_A, [], { sha: "abc", verdict: "fail", recovery: false }, 1);
  store.reserve(URL_A, [], { sha: "abc", verdict: "pass", recovery: true }, 2);
  assert.deepEqual(store.reportedSha(URL_A, "abc"), { reason: "delivered", verdict: "pass" });
});

test("rollback restores everything reserve changed and says cancelled", () => {
  const store = open();
  enroll(store);
  store.recordNew(URL_A, { pending: [pending("p")], ignored: ["i"], saturated: true });
  const reservation = store.reserve(URL_A, ["p"], { sha: "abc", verdict: "pass", recovery: false }, 500);
  store.rollback(reservation);
  assert.deepEqual(store.pendingItems(URL_A), [pending("p")]);
  assert.deepEqual([...store.knownIds(URL_A)].sort(), ["i", "p"]);
  assert.equal(store.reportedSha(URL_A, "abc"), null);
  assert.equal(store.binding(URL_A)?.mayBeMissing, true);
  assert.equal(store.binding(URL_A)?.lastOutcome, "cancelled");
});

test("rollback of a recovery flips back to fail", () => {
  const store = open();
  enroll(store);
  store.reserve(URL_A, [], { sha: "abc", verdict: "fail", recovery: false }, 1);
  store.rollback(store.reserve(URL_A, [], { sha: "abc", verdict: "pass", recovery: true }, 2));
  assert.deepEqual(store.reportedSha(URL_A, "abc"), { reason: "delivered", verdict: "fail" });
});

test("sending becomes unknown at startup; other outcomes stay", () => {
  const store = open();
  enroll(store);
  enroll(store, { prUrl: URL_B });
  store.reserve(URL_A, [], null, 1);
  store.reserve(URL_B, [], null, 1);
  store.setOutcome(URL_B, "sent");
  store.resolveInterrupted();
  assert.equal(store.binding(URL_A)?.lastOutcome, "unknown");
  assert.equal(store.binding(URL_B)?.lastOutcome, "sent");
});

test("transfer changes the owner and keeps the cursors", () => {
  const store = open();
  store.enroll(binding(), { itemIds: ["a"], ci: { sha: "abc", verdict: "pass" } });
  store.recordNew(URL_A, { pending: [pending("p")], ignored: [], saturated: false });
  store.transfer(URL_A, {
    threadId: "thr_b",
    environmentId: "env_2",
    hostId: "host_2",
    claimedBy: "user",
    since: 900,
    branchBound: false,
    nextPollAt: 1000,
  });
  const row = store.binding(URL_A);
  assert.equal(row?.threadId, "thr_b");
  assert.equal(row?.environmentId, "env_2");
  assert.equal(row?.hostId, "host_2");
  assert.equal(row?.claimedBy, "user");
  assert.equal(row?.branchBound, false);
  assert.equal(store.pendingItems(URL_A).length, 1);
  assert.deepEqual(store.reportedSha(URL_A, "abc"), { reason: "baselined", verdict: "pass" });
  assert.ok(store.knownIds(URL_A).has("a"));
});

test("moveOwner keeps claimedBy", () => {
  const store = open();
  enroll(store, { claimedBy: "user" });
  store.moveOwner(URL_A, "thr_parent");
  assert.equal(store.binding(URL_A)?.threadId, "thr_parent");
  assert.equal(store.binding(URL_A)?.claimedBy, "user");
});

test("drop removes the binding and every row of the PR, and only that PR", () => {
  const store = open();
  store.enroll(binding(), { itemIds: ["a"], ci: { sha: "abc", verdict: "pass" } });
  store.recordNew(URL_A, { pending: [pending("p")], ignored: [], saturated: false });
  store.enroll(binding({ prUrl: URL_B }), { itemIds: ["b"], ci: null });
  store.drop(URL_A);
  assert.equal(store.binding(URL_A), null);
  assert.equal(store.knownIds(URL_A).size, 0);
  assert.equal(store.pendingItems(URL_A).length, 0);
  assert.equal(store.reportedSha(URL_A, "abc"), null);
  assert.ok(store.binding(URL_B));
  assert.ok(store.knownIds(URL_B).has("b"));
});

test("queries by thread, environment and due time", () => {
  const store = open();
  enroll(store, { nextPollAt: 10 });
  enroll(store, { prUrl: URL_B, threadId: "thr_b", environmentId: "env_2", nextPollAt: 20 });
  assert.deepEqual(store.forThread("thr_b").map((row) => row.prUrl), [URL_B]);
  assert.deepEqual(store.forEnvironment("env_1").map((row) => row.prUrl), [URL_A]);
  assert.deepEqual(store.due(10).map((row) => row.prUrl), [URL_A]);
  store.setNextPoll(URL_A, 99);
  assert.deepEqual(store.due(20).map((row) => row.prUrl), [URL_B]);
});

test("thread_off", () => {
  const store = open();
  assert.equal(store.isOff("thr_a"), false);
  store.setOff("thr_a", 1);
  store.setOff("thr_a", 2);
  assert.equal(store.isOff("thr_a"), true);
  store.clearOff("thr_a");
  assert.equal(store.isOff("thr_a"), false);
});
