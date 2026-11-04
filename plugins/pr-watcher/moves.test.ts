// Moving and dropping watches: `watch --from`, `pr_watch` with `from`, and `unwatch --pr`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { comment, failing, OTHER_PR, type Plugin, PR, snapshot, THREAD, threadRow, withPlugin } from "./test-support.ts";

const CHILD = "thr_child";

const text = (result: unknown) =>
  typeof result === "string" ? result : ((result as { content: { text: string }[] }).content[0]?.text ?? "");

/** A child that owns two PRs, the second with a comment waiting while the child is busy. */
async function childWithTwoWatches(plugin: Plugin): Promise<void> {
  plugin.world.threads.set(CHILD, threadRow({ id: CHILD, parentThreadId: THREAD }));
  plugin.world.snapshots.set(OTHER_PR, snapshot({ url: OTHER_PR }));
  await plugin.claim({}, CHILD);
  await plugin.claim({ pr: OTHER_PR }, CHILD);
  plugin.world.threads.set(CHILD, threadRow({ id: CHILD, parentThreadId: THREAD, status: "active", runtime: { displayStatus: "active" } }));
  plugin.world.snapshots.set(OTHER_PR, snapshot({ url: OTHER_PR, items: [comment("c1")] }));
  plugin.settle();
  await plugin.poll();
}

test("watch --from moves every watch of a child, with its pending items, and the next wake goes to the parent", async () => {
  await withPlugin({}, async (plugin) => {
    await childWithTwoWatches(plugin);
    assert.equal((await plugin.status(CHILD)).bindings.length, 2);

    const result = await plugin.cli(["watch", THREAD, "--from", CHILD]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout ?? "", new RegExp(`^moved 2 of 2 watches from ${CHILD} to ${THREAD}`));
    assert.equal((await plugin.status(CHILD)).bindings.length, 0);
    const moved = (await plugin.status(THREAD)).bindings;
    assert.deepEqual(moved.map((row) => row.pr).sort(), [PR, OTHER_PR]);
    assert.equal(moved.find((row) => row.pr === OTHER_PR)?.pendingItems, 1);
    assert.equal(moved.find((row) => row.pr === OTHER_PR)?.branchBound, false, "the parent's checkout isn't the PR");

    // The coordinator stops the child once its watches have moved; a running child would hold the wake.
    plugin.world.threads.set(CHILD, threadRow({ id: CHILD, parentThreadId: THREAD }));
    plugin.settle();
    await plugin.poll();
    assert.deepEqual(
      plugin.world.sends.map((send) => send.threadId),
      [THREAD],
    );
    assert.match(plugin.sentText(), /comment c1/);
  });
});

test("pr_watch with from moves the child's watches to the calling thread", async () => {
  await withPlugin({}, async (plugin) => {
    await childWithTwoWatches(plugin);
    const result = text(await plugin.claim({ from: CHILD } as { pr?: string }));
    assert.match(result, /^moved 2 of 2 watches/);
    assert.equal((await plugin.status(THREAD)).bindings.length, 2);
  });
});

test("pr_watch refuses pr and from together", async () => {
  await withPlugin({}, async (plugin) => {
    const result = await plugin.claim({ pr: PR, from: CHILD } as { pr?: string });
    assert.match(text(result), /pass pr or from, not both/);
  });
});

test("watch --from to a thread that can't own watches is refused, and nothing moves", async () => {
  await withPlugin({}, async (plugin) => {
    await childWithTwoWatches(plugin);
    plugin.world.threads.set("thr_side", threadRow({ id: "thr_side", visibility: "hidden" }));
    const result = await plugin.cli(["watch", "thr_side", "--from", CHILD]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout ?? "", /not_eligible/);
    assert.equal((await plugin.status(CHILD)).bindings.length, 2);
  });
});

test("an agent's move doesn't turn a thread back on that the user turned off", async () => {
  await withPlugin({}, async (plugin) => {
    await childWithTwoWatches(plugin);
    await plugin.cli(["unwatch", THREAD]);
    const result = text(await plugin.claim({ from: CHILD } as { pr?: string }));
    assert.match(result, /^moved 0 of 2 watches/);
    assert.match(result, /watching_off/);
    assert.equal((await plugin.status(CHILD)).bindings.length, 2);
  });
});

test("unwatch --pr ends one watch and leaves the thread on", async () => {
  await withPlugin({}, async (plugin) => {
    await childWithTwoWatches(plugin);
    const result = await plugin.cli(["unwatch", CHILD, "--pr", OTHER_PR]);
    assert.match(result.stdout ?? "", /stopped watching 1 pull request/);
    const left = await plugin.status(CHILD);
    assert.deepEqual(left.bindings.map((row) => row.pr), [PR]);
    assert.equal(left.off, false);
    plugin.world.snapshots.set(OTHER_PR, snapshot({ url: OTHER_PR, ci: failing }));
    assert.match(text(await plugin.claim({ pr: OTHER_PR }, CHILD)), /^watching/, "the agent can still claim");
  });
});
