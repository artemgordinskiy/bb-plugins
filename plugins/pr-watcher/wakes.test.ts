// End-to-end wake rules through the plugin, with the default settings unless a test says otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "./contract.ts";
import { check, comment, failing, NEW_SHA, passing, review, SHA, watching, withPlugin } from "./test-support.ts";

const approved = (ids: string[] = ["r1"]): Partial<Snapshot> => ({
  ci: passing,
  reviewDecision: "APPROVED",
  mergeState: "CLEAN",
  opinions: ids.map((id) => ({ id, author: `reviewer-${id}`, state: "APPROVED" as const })),
  items: ids.map((id) => review(id, { reviewState: "APPROVED", excerpt: "", author: `reviewer-${id}` })),
});

test("the thr_gwrzvj2uxp pattern: restacks and a bare approval stay quiet, and ready to merge wakes once", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: passing });
    await plugin.poll();
    plugin.setSnapshot({ headSha: "restack1", ci: passing });
    await plugin.poll();
    // Approved while a restack's CI runs: no wake yet.
    plugin.setSnapshot({ ...approved(), headSha: "restack2", mergeState: "BLOCKED", ci: { ...passing, rollup: "PENDING" } });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);

    plugin.setSnapshot({ ...approved(), headSha: "restack2" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /Ready to merge: approved by @reviewer-r1, checks green, GitHub says it can merge\./);
    assert.doesNotMatch(plugin.sentText(), /New feedback/, "the bare approval rides in the ready line");

    plugin.setSnapshot({ ...approved(), headSha: "restack3" });
    await plugin.poll();
    plugin.setSnapshot({ ...approved(["r1", "r2"]), headSha: "restack3" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1, "a restack and a second approval stay quiet");
  });
});

test("a failure, then a pass on the fixing commit, wakes twice", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    plugin.setSnapshot({ headSha: NEW_SHA, ci: passing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 2);
    assert.match(plugin.sentText(1), /CI now passing on fed4321/);
  });
});

test("an approval with a comment still wakes as feedback", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: passing, items: [review("r1", { reviewState: "APPROVED", excerpt: "Rename the flag first" })] });
    await plugin.poll();
    assert.match(plugin.sentText(), /@reviewer reviewed: approved\./);
  });
});

test("an approved, green draft wakes once to say it's still a draft", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ...approved(), isDraft: true, mergeState: "DRAFT" });
    await plugin.poll();
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /Still a draft: approved by @reviewer-r1 and checks green\./);
  });
});

test("leaving the merge queue without merging wakes; going in doesn't", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ...approved(), queued: true });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0, "no ready wake while queued");
    assert.equal((await plugin.status()).bindings[0]?.merge, "queued");
    plugin.setSnapshot({ ...approved(), mergeState: "BLOCKED", ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /Left the merge queue without merging/);
  });
});

test("a PR that is already ready when claimed doesn't wake for it", async () => {
  await withPlugin({}, async (plugin) => {
    plugin.setSnapshot(approved());
    await plugin.claim();
    plugin.settle();
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
  });
});

test("a saved setting applies on the next poll, with no reload", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: passing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
    await plugin.harness.setSettings({ ciPassWakes: "every-commit", instructionLine: "Just report." });
    plugin.setSnapshot({ headSha: NEW_SHA, ci: passing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /CI passed on fed4321/);
    assert.match(plugin.sentText(), /^Just report\.$/m);
  });
});

test("failing checks that aren't required: wake by default, or listed only with another wake", async () => {
  const ci = { rollup: "FAILURE" as const, hasNextPage: false, checks: [check({ required: true }), check({ name: "types", conclusion: "FAILURE" })] };
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci });
    await plugin.poll();
    assert.match(plugin.sentText(), /CI failed on abc1234: types \(not required\)/);
  });
  await watching(
    async (plugin) => {
      plugin.setSnapshot({ ci });
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 0);
      plugin.setSnapshot({ ci, items: [comment("c1")] });
      await plugin.poll();
      assert.match(plugin.sentText(), /Also failing, not required: types \(not required\)/);
    },
    { settings: { optionalCheckFailures: "mention" } },
  );
});

test("the quiet time is a setting", async () => {
  await withPlugin({ settings: { quietSeconds: 0 } }, async (plugin) => {
    await plugin.claim();
    plugin.setSnapshot({ ci: failing, headSha: SHA });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1, "no wait after the claim");
  });
});

test("with a red check that isn't required, ready to merge still wakes", async () => {
  const ci = { rollup: "FAILURE" as const, hasNextPage: false, checks: [check({ required: true }), check({ name: "claude", conclusion: "FAILURE" })] };
  await watching(async (plugin) => {
    plugin.setSnapshot({ ...approved(), ci, mergeState: "UNSTABLE" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /CI failed on abc1234: claude \(not required\)/);
    assert.match(plugin.sentText(), /Ready to merge: approved by @reviewer-r1/);
  });
});

test("approved, changes requested, approved again: the re-approval wakes", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot(approved(["a"]));
    await plugin.poll();
    plugin.setSnapshot({
      ...approved(["a"]),
      reviewDecision: "CHANGES_REQUESTED",
      mergeState: "BLOCKED",
      opinions: [
        { id: "a", author: "reviewer-a", state: "APPROVED" },
        { id: "b1", author: "reviewer-b", state: "CHANGES_REQUESTED" },
      ],
      items: [review("b1", { author: "reviewer-b", excerpt: "Please rename the flag" })],
    });
    await plugin.poll();
    plugin.setSnapshot({
      ...approved(["a", "b2"]),
      items: [review("b1", { author: "reviewer-b", excerpt: "Please rename the flag" }), review("b2", { reviewState: "APPROVED", excerpt: "", author: "reviewer-b" })],
    });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 3);
    assert.match(plugin.sentText(1), /changes requested/);
    assert.match(plugin.sentText(2), /Ready to merge/);
  });
});
