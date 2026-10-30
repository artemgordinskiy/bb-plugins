import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check, Snapshot, SnapshotItem } from "./contract.ts";
import {
  ACTIVE_POLL_MS,
  ciReport,
  type CiState,
  classifyNew,
  IDLE_WINDOW_MS,
  IDLE_POLL_MS,
  isRelevant,
  nextPollDelay,
  parseBotAuthors,
  readCi,
} from "./triggers.ts";

const BOTS = parseBotAuthors("copilot-pull-request-reviewer, coderabbitai, claude, chatgpt-codex-connector");

const run = (name: string, status = "COMPLETED", conclusion: string | null = "SUCCESS"): Check => ({
  kind: "run",
  name,
  status,
  conclusion,
  url: null,
});
const context = (name: string, state: string): Check => ({ kind: "context", name, status: state, conclusion: null, url: null });
const ci = (
  rollup: Snapshot["ci"]["rollup"],
  checks: Check[],
  hasNextPage = false,
): Snapshot["ci"] => ({ rollup, checks, hasNextPage });

const item = (over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  id: "i1",
  kind: "comment",
  author: "alice",
  authorIsBot: false,
  association: "MEMBER",
  inlineCount: 0,
  at: "2026-10-30T10:00:00Z",
  url: "https://github.com/acme/api/pull/42#issuecomment-1",
  excerpt: "",
  ...over,
});

const relevant = (over: Partial<SnapshotItem>) => isRelevant(item(over), "viewer", BOTS);

test("readCi: no checks is no CI, even with a terminal rollup", () => {
  assert.deepEqual(readCi(ci(null, [])), { kind: "none" });
  assert.deepEqual(readCi(ci("SUCCESS", [])), { kind: "none" });
});

test("readCi: an unfinished check keeps CI running whatever the rollup says", () => {
  assert.deepEqual(readCi(ci("FAILURE", [run("a", "IN_PROGRESS", null)])), { kind: "running" });
  assert.deepEqual(readCi(ci("SUCCESS", [run("a"), context("b", "PENDING")])), { kind: "running" });
  assert.deepEqual(readCi(ci("SUCCESS", [context("b", "EXPECTED")])), { kind: "running" });
});

test("readCi: a pending rollup with every listed check finished is still running", () => {
  assert.deepEqual(readCi(ci("PENDING", [run("a")])), { kind: "running" });
  assert.deepEqual(readCi(ci("EXPECTED", [run("a")])), { kind: "running" });
});

test("readCi: the verdict comes from the rollup", () => {
  assert.deepEqual(readCi(ci("SUCCESS", [run("a")])), { kind: "settled", verdict: "pass", failed: [] });
  const failed = readCi(ci("FAILURE", [run("a"), run("b", "COMPLETED", "FAILURE")]));
  assert.equal(failed.kind === "settled" && failed.verdict, "fail");
  assert.equal(readCi(ci("ERROR", [context("a", "ERROR")])).kind, "settled");
});

test("readCi: failed checks skip the conclusions that count as fine", () => {
  const checks = [
    run("ok"),
    run("neutral", "COMPLETED", "NEUTRAL"),
    run("skipped", "COMPLETED", "SKIPPED"),
    run("bad", "COMPLETED", "FAILURE"),
    run("cancelled", "COMPLETED", "CANCELLED"),
    run("timed out", "COMPLETED", "TIMED_OUT"),
    context("ctx ok", "SUCCESS"),
    context("ctx bad", "FAILURE"),
    context("ctx err", "ERROR"),
  ];
  const state = readCi(ci("FAILURE", checks));
  assert.ok(state.kind === "settled");
  assert.deepEqual(
    state.failed.map((check) => check.name),
    ["bad", "cancelled", "timed out", "ctx bad", "ctx err"],
  );
});

test("readCi: past 100 checks a terminal rollup is unsupported, never settled", () => {
  assert.deepEqual(readCi(ci("FAILURE", [run("a", "COMPLETED", "FAILURE")], true)), { kind: "unsupported" });
  assert.deepEqual(readCi(ci("SUCCESS", [run("a")], true)), { kind: "unsupported" });
});

const pass: CiState = { kind: "settled", verdict: "pass", failed: [] };
const fail = { kind: "settled", verdict: "fail", failed: [run("a", "COMPLETED", "FAILURE")] } satisfies CiState;

test("ciReport: the first settled observation of a SHA reports", () => {
  assert.deepEqual(ciReport("abc", pass, null), { kind: "passed", sha: "abc" });
  assert.deepEqual(ciReport("abc", fail, null), { kind: "failed", sha: "abc", checks: fail.failed });
});

test("ciReport: nothing unless CI is settled", () => {
  for (const state of [{ kind: "none" }, { kind: "running" }, { kind: "unsupported" }] as const) {
    assert.equal(ciReport("abc", state, null), null);
  }
});

test("ciReport: a reported SHA stays reported", () => {
  assert.equal(ciReport("abc", fail, { reason: "delivered", verdict: "fail" }), null);
  assert.equal(ciReport("abc", pass, { reason: "delivered", verdict: "pass" }), null);
});

test("ciReport: a delivered failure that passes is one recovery", () => {
  assert.deepEqual(ciReport("abc", pass, { reason: "delivered", verdict: "fail" }), { kind: "recovered", sha: "abc" });
});

test("ciReport: a delivered pass that then fails stays silent", () => {
  assert.equal(ciReport("abc", fail, { reason: "delivered", verdict: "pass" }), null);
});

test("ciReport: a baselined failure never recovers", () => {
  assert.equal(ciReport("abc", pass, { reason: "baselined", verdict: "fail" }), null);
  assert.equal(ciReport("abc", fail, { reason: "baselined", verdict: "pass" }), null);
});

test("parseBotAuthors: trims, lowercases and strips [bot]", () => {
  assert.deepEqual([...parseBotAuthors(" CodeRabbitAI[bot] , claude,, ")], ["coderabbitai", "claude"]);
});

test("isRelevant: humans count through any item by association", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(relevant({ association }), true);
    assert.equal(relevant({ association, kind: "review", reviewState: "APPROVED" }), true);
  }
});

test("isRelevant: outsiders are dropped", () => {
  for (const association of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"]) {
    assert.equal(relevant({ association }), false);
  }
});

test("isRelevant: the viewer is always dropped, in any case", () => {
  assert.equal(relevant({ author: "viewer", association: "OWNER" }), false);
  assert.equal(relevant({ author: "Viewer", association: "OWNER" }), false);
});

test("isRelevant: all four default bots count through reviews", () => {
  for (const author of ["copilot-pull-request-reviewer", "coderabbitai", "claude", "chatgpt-codex-connector"]) {
    assert.equal(
      relevant({ author, authorIsBot: true, association: "NONE", kind: "review", reviewState: "COMMENTED", inlineCount: 2 }),
      true,
      author,
    );
  }
});

test("isRelevant: the setting works with the REST [bot] form", () => {
  const bots = parseBotAuthors("coderabbitai[bot]");
  const review = item({ author: "coderabbitai", authorIsBot: true, kind: "review", reviewState: "APPROVED" });
  assert.equal(isRelevant(review, "viewer", bots), true);
});

test("isRelevant: a listed bot's conversation comment never counts", () => {
  assert.equal(relevant({ author: "claude", authorIsBot: true, association: "MEMBER", kind: "comment" }), false);
});

test("isRelevant: other bots are ignored, even with a member association", () => {
  assert.equal(
    relevant({ author: "github-actions", authorIsBot: true, association: "MEMBER", kind: "review", reviewState: "APPROVED" }),
    false,
  );
});

test("isRelevant: a User named like a listed bot is not that bot", () => {
  assert.equal(relevant({ author: "claude", authorIsBot: false, association: "NONE", kind: "review", reviewState: "APPROVED" }), false);
});

test("isRelevant: an empty COMMENTED review is dropped; with inline comments it counts", () => {
  assert.equal(relevant({ kind: "review", reviewState: "COMMENTED", excerpt: "body", inlineCount: 0 }), false);
  assert.equal(relevant({ kind: "review", reviewState: "COMMENTED", inlineCount: 1 }), true);
});

test("isRelevant: a dismissed review is dropped", () => {
  assert.equal(relevant({ kind: "review", reviewState: "DISMISSED", inlineCount: 3 }), false);
});

const snapshotWith = (items: SnapshotItem[]) => ({ viewerLogin: "viewer", items });

test("classifyNew: splits new items and skips known ones", () => {
  const result = classifyNew(
    snapshotWith([item({ id: "seen" }), item({ id: "new" }), item({ id: "outsider", association: "NONE" })]),
    new Set(["seen"]),
    BOTS,
  );
  assert.deepEqual(result.pending.map((entry) => entry.id), ["new"]);
  assert.deepEqual(result.ignored, ["outsider"]);
  assert.equal(result.saturated, false);
});

test("classifyNew: all 100 new reviews or all 100 new comments saturate", () => {
  const reviews = Array.from({ length: 100 }, (_, n) => item({ id: `r${n}`, kind: "review", reviewState: "APPROVED", association: "NONE" }));
  const comments = Array.from({ length: 100 }, (_, n) => item({ id: `c${n}`, association: "NONE" }));
  assert.equal(classifyNew(snapshotWith(reviews), new Set(), BOTS).saturated, true);
  assert.equal(classifyNew(snapshotWith(comments), new Set(), BOTS).saturated, true);
});

test("classifyNew: one known item out of 100, or 99 new items, is not saturation", () => {
  const comments = Array.from({ length: 100 }, (_, n) => item({ id: `c${n}` }));
  assert.equal(classifyNew(snapshotWith(comments), new Set(["c7"]), BOTS).saturated, false);
  assert.equal(classifyNew(snapshotWith(comments.slice(1)), new Set(), BOTS).saturated, false);
});

test("nextPollDelay: 60 s while CI runs", () => {
  assert.equal(nextPollDelay({ kind: "running" }, null, 0), ACTIVE_POLL_MS);
});

test("nextPollDelay: 60 s for ten minutes after the owner goes idle", () => {
  const now = 1_000_000;
  assert.equal(nextPollDelay({ kind: "none" }, now - IDLE_WINDOW_MS + 1, now), ACTIVE_POLL_MS);
  assert.equal(nextPollDelay({ kind: "none" }, now - IDLE_WINDOW_MS, now), IDLE_POLL_MS);
});

test("nextPollDelay: 5 min otherwise, including unsupported and settled CI", () => {
  assert.equal(nextPollDelay({ kind: "none" }, null, 0), IDLE_POLL_MS);
  assert.equal(nextPollDelay({ kind: "unsupported" }, null, 0), IDLE_POLL_MS);
  assert.equal(nextPollDelay(pass, null, 0), IDLE_POLL_MS);
});
