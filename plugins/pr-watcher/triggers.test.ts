import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseBotAuthors, parseRoles } from "./config.ts";
import type { SnapshotItem } from "./contract.ts";
import {
  ACTIVE_POLL_MS,
  classifyNew,
  IDLE_WINDOW_MS,
  IDLE_POLL_MS,
  isRelevant,
  nextPollDelay,
} from "./triggers.ts";

const BOTS = DEFAULT_CONFIG.feedback;

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

test("parseBotAuthors: trims, lowercases and strips [bot]", () => {
  assert.deepEqual([...parseBotAuthors(" CodeRabbitAI[bot] , claude,, ")], ["coderabbitai", "claude"]);
});

test("isRelevant: humans count through any item by association", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(relevant({ association }), true);
    assert.equal(relevant({ association, kind: "review", reviewState: "APPROVED", excerpt: "One nit" }), true);
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
  const bots = { ...BOTS, bots: parseBotAuthors("coderabbitai[bot]") };
  const review = item({ author: "coderabbitai", authorIsBot: true, kind: "review", reviewState: "CHANGES_REQUESTED" });
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
  assert.equal(nextPollDelay({ kind: "settled", verdict: "pass", failed: [], optionalFailed: [] }, null, 0), IDLE_POLL_MS);
});

test("isRelevant: a bare approval counts only when every approval wakes", () => {
  const bare = { kind: "review" as const, reviewState: "APPROVED" as const, inlineCount: 0, excerpt: " " };
  assert.equal(relevant(bare), false, "the default leaves it to Ready to merge");
  assert.equal(isRelevant(item(bare), "viewer", { ...BOTS, bareApprovals: true }), true);
  assert.equal(relevant({ ...bare, inlineCount: 1 }), true, "an approval with an inline comment counts");
  assert.equal(relevant({ ...bare, excerpt: "LGTM, but rename the flag" }), true, "an approval with text counts");
});

test("isRelevant: the feedback roles come from the setting, in any case", () => {
  const rules = { ...BOTS, roles: parseRoles(" owner , Contributor ") };
  assert.equal(isRelevant(item({ association: "CONTRIBUTOR" }), "viewer", rules), true);
  assert.equal(isRelevant(item({ association: "MEMBER" }), "viewer", rules), false);
});
