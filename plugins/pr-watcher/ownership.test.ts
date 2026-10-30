import assert from "node:assert/strict";
import { test } from "node:test";
import { branchBound, claimKind, findHandoff, isEligible, type ThreadFacts } from "./ownership.ts";

const thread = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  id: "thr_a",
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  originPluginId: null,
  parentThreadId: null,
  environmentId: "env_1",
  ...over,
});

const loader = (rows: ThreadFacts[]) => async (id: string) => rows.find((row) => row.id === id) ?? null;

test("isEligible: an ordinary thread, a user fork and a child are eligible", () => {
  assert.equal(isEligible(thread()), true);
  assert.equal(isEligible(thread({ parentThreadId: "thr_p" })), true);
});

test("isEligible: archived, deleted, hidden and plugin-spawned threads are not", () => {
  assert.equal(isEligible(thread({ archivedAt: 1 })), false);
  assert.equal(isEligible(thread({ deletedAt: 1 })), false);
  assert.equal(isEligible(thread({ visibility: "hidden" })), false);
  assert.equal(isEligible(thread({ originPluginId: "side-chat" })), false);
  assert.equal(isEligible(thread({ originPluginId: "workflows" })), false);
});

test("branchBound: a claim with no URL is bound", () => {
  assert.equal(branchBound(false, "https://github.com/a/b/pull/1", null), true);
});

test("branchBound: a URL naming the checkout's PR is bound; one off it is not", () => {
  const url = "https://github.com/a/b/pull/1";
  assert.equal(branchBound(true, url, url), true);
  assert.equal(branchBound(true, url, "https://github.com/a/b/pull/2"), false);
});

test("branchBound: a URL claim with an unresolved checkout is not bound", () => {
  assert.equal(branchBound(true, "https://github.com/a/b/pull/1", null), false);
});

test("claimKind", () => {
  assert.equal(claimKind(null, "thr_a"), "enroll");
  assert.equal(claimKind("thr_a", "thr_a"), "same");
  assert.equal(claimKind("thr_b", "thr_a"), "transfer");
});

test("findHandoff: moves to the nearest eligible parent in the same environment", async () => {
  const parent = thread({ id: "thr_p" });
  const owner = thread({ parentThreadId: "thr_p" });
  assert.equal(await findHandoff(owner, "env_1", loader([parent])), "thr_p");
});

test("findHandoff: skips ineligible parents on the way up", async () => {
  const grandparent = thread({ id: "thr_g" });
  const parent = thread({ id: "thr_p", archivedAt: 5, parentThreadId: "thr_g" });
  const owner = thread({ parentThreadId: "thr_p" });
  assert.equal(await findHandoff(owner, "env_1", loader([parent, grandparent])), "thr_g");
});

test("findHandoff: a nearest eligible parent in another environment ends the watch", async () => {
  const grandparent = thread({ id: "thr_g" });
  const parent = thread({ id: "thr_p", environmentId: "env_2", parentThreadId: "thr_g" });
  const owner = thread({ parentThreadId: "thr_p" });
  assert.equal(await findHandoff(owner, "env_1", loader([parent, grandparent])), null);
});

test("findHandoff: no parent, or a parent that no longer exists, ends the watch", async () => {
  assert.equal(await findHandoff(thread(), "env_1", loader([])), null);
  assert.equal(await findHandoff(thread({ parentThreadId: "thr_gone" }), "env_1", loader([])), null);
});

test("findHandoff: a parent cycle ends the watch instead of spinning", async () => {
  const a = thread({ id: "thr_a", archivedAt: 1, parentThreadId: "thr_b" });
  const b = thread({ id: "thr_b", archivedAt: 1, parentThreadId: "thr_a" });
  assert.equal(await findHandoff(a, "env_1", loader([a, b])), null);
});
