import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatusOutput } from "./contract.ts";
import { isRunning, QUIET_MS, type ThreadRow, WorkClock, workSet } from "./delivery.ts";
import { comment, failing, NEW_SHA, OTHER_PR, passing, PR, review, running, SHA, THREAD, threadRow, watching, withPlugin } from "./test-support.ts";

const row = (overrides: Parameters<typeof threadRow>[0]) => threadRow(overrides) as unknown as ThreadRow;

const busyRow = (id: string, overrides = {}) => threadRow({ id, status: "active", runtime: { displayStatus: "active" }, ...overrides });

const ids = (rows: ThreadRow[]) => rows.map((entry) => entry.id).sort();

test("isRunning: every state a send would only queue on, by status or display status", () => {
  for (const status of ["active", "starting", "stopping"]) assert.ok(isRunning(row({ id: "t", status })));
  for (const displayStatus of ["provisioning", "waiting-for-host"]) {
    assert.ok(isRunning(row({ id: "t", runtime: { displayStatus } })));
  }
  assert.ok(!isRunning(row({ id: "t" })));
  assert.ok(!isRunning(row({ id: "t", status: "active", archivedAt: 1 })));
});

test("workSet: follows parent and lifecycle-owner links, transitively, and survives a cycle", () => {
  const rows = [
    row({ id: "child", parentThreadId: "owner" }),
    row({ id: "step", lifecycleOwnerThreadId: "child" }),
    row({ id: "step-of-step", lifecycleOwnerThreadId: "step" }),
    row({ id: "loop", parentThreadId: "step-of-step", lifecycleOwnerThreadId: "loop" }),
    row({ id: "stranger" }),
  ];
  assert.deepEqual(ids(workSet("owner", rows)), ["child", "loop", "step", "step-of-step"]);
});

test("WorkClock: not quiet until the time has passed since a restart and since the last work", () => {
  const clock = new WorkClock(1000);
  assert.ok(!clock.quiet([], 1000 + QUIET_MS - 1));
  assert.ok(clock.quiet([], 1000 + QUIET_MS));
  clock.stamp("t", 5000);
  assert.ok(!clock.quiet(["t"], 5000 + QUIET_MS - 1));
  assert.ok(clock.quiet(["t"], 5000 + QUIET_MS));
});

test("WorkClock: prune forgets only what can no longer hold anything", () => {
  const clock = new WorkClock(0);
  clock.stamp("old", QUIET_MS);
  clock.stamp("new", 2 * QUIET_MS - 1);
  clock.prune(2 * QUIET_MS);
  assert.ok(clock.quiet(["old"], 2 * QUIET_MS));
  assert.ok(!clock.quiet(["new"], 2 * QUIET_MS));
});

test("the cursors are written before threads.send is called", async () => {
  await watching(async (plugin) => {
    let duringSend: StatusOutput | undefined;
    plugin.world.sendResult = async () => {
      duringSend = await plugin.status();
      return { ok: true, delivery: "sent" };
    };
    plugin.setSnapshot({ ci: failing, items: [comment("c1")] });
    await plugin.poll();
    assert.equal(duringSend?.bindings[0]?.pendingItems, 0);
    assert.equal(duringSend?.bindings[0]?.lastOutcome, "sending");
    assert.equal((await plugin.status()).bindings[0]?.lastOutcome, "sent");
  });
});

test("the wake starts the thread and carries the plugin's origin", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    const [send] = plugin.world.sends;
    assert.equal(send?.threadId, THREAD);
    assert.equal(send?.mode, "start");
    assert.equal(send?.originPluginId, "pr-watcher");
  });
});

test("the checkout check runs once, before the final owner check", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    plugin.world.log.length = 0;
    await plugin.poll();
    assert.deepEqual(plugin.world.log, ["threads.list:ids", "host:snapshot", "host:checkout", "threads.list:ids", "threads.list:inventory", "threads.send"]);
  });
});

test("queued and the delete succeeds: rolled back, then delivered later", async () => {
  await watching(async (plugin) => {
    plugin.world.sendResult = () => ({ ok: true, delivery: "queued", queuedMessage: { id: "q1" } });
    plugin.setSnapshot({ ci: failing, items: [comment("c1")] });
    await plugin.poll();
    assert.deepEqual(plugin.world.deletes, [{ threadId: THREAD, queuedMessageId: "q1" }]);
    const held = (await plugin.status()).bindings[0];
    assert.equal(held?.lastOutcome, "cancelled");
    assert.equal(held?.pendingItems, 1);

    plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 2);
    assert.match(plugin.sentText(1), /CI failed on abc1234/);
    assert.match(plugin.sentText(1), /commented/);
    assert.equal((await plugin.status()).bindings[0]?.lastOutcome, "sent");
  });
});

for (const [name, deleteResult] of [
  ["404", () => { throw Object.assign(new Error("gone"), { status: 404 }); }],
  ["fails", () => { throw new Error("boom"); }],
] as const) {
  test(`queued and the delete ${name}: unknown, and the items stay seen`, async () => {
    await watching(async (plugin) => {
      plugin.world.sendResult = () => ({ ok: true, delivery: "queued", queuedMessage: { id: "q1" } });
      plugin.world.deleteResult = deleteResult;
      plugin.setSnapshot({ ci: failing, items: [comment("c1")] });
      await plugin.poll();
      plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
      await plugin.poll();
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 1);
      const binding = (await plugin.status()).bindings[0];
      assert.equal(binding?.lastOutcome, "unknown");
      assert.equal(binding?.pendingItems, 0);
    });
  });
}

test("threads.send throws: unknown, and no second wake", async () => {
  await watching(async (plugin) => {
    plugin.world.sendResult = () => {
      throw new Error("already_active");
    };
    plugin.setSnapshot({ ci: failing, items: [comment("c1")] });
    await plugin.poll();
    plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.equal((await plugin.status()).bindings[0]?.lastOutcome, "unknown");
  });
});

test("a recovery that is rolled back flips back to fail and is delivered later", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    plugin.setSnapshot({ ci: passing });
    plugin.world.sendResult = () => ({ ok: true, delivery: "queued", queuedMessage: { id: "q1" } });
    await plugin.poll();
    plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 3);
    assert.match(plugin.sentText(2), /CI now passing on abc1234/);
  });
});

test("a recovery with outcome unknown is not repeated", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    plugin.setSnapshot({ ci: passing });
    plugin.world.sendResult = () => {
      throw new Error("lost");
    };
    await plugin.poll();
    plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 2);
  });
});

test("`sending` at startup becomes unknown and counts as sent", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing, items: [comment("c1")] });
    plugin.world.sendResult = () => new Promise(() => {});
    void plugin.poll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(plugin.world.sends.length, 1);
    plugin.world.sendResult = () => ({ ok: true, delivery: "sent" });
    await plugin.restart();
    plugin.settle();
    assert.equal((await plugin.status()).bindings[0]?.lastOutcome, "unknown");
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("the startup sweep deletes only our rows and re-arms nothing", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    plugin.world.queue = [
      { id: "ours", threadId: THREAD, originPluginId: "pr-watcher" },
      { id: "theirs", threadId: THREAD, originPluginId: "other" },
      { id: "user", threadId: THREAD, originPluginId: null },
    ];
    plugin.world.deleteResult = () => ({ ok: true });
    await plugin.restart();
    assert.deepEqual(plugin.world.deletes, [{ threadId: THREAD, queuedMessageId: "ours" }]);
    plugin.settle();
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("the sweep logs a failed delete and carries on", async () => {
  await watching(async (plugin) => {
    plugin.world.queue = [
      { id: "a", threadId: THREAD, originPluginId: "pr-watcher" },
      { id: "b", threadId: THREAD, originPluginId: "pr-watcher" },
    ];
    plugin.world.deleteResult = () => {
      throw new Error("nope");
    };
    await plugin.restart();
    assert.equal(plugin.world.deletes.length, 2);
  });
});

const held = [
  ["owner running", { status: "active" }, "owner busy"],
  ["owner displayed as waiting for a host", { runtime: { displayStatus: "waiting-for-host" } }, "owner busy"],
  ["owner pending", { status: "pending" }, "owner busy"],
  ["a pending interaction", { hasPendingInteraction: true }, "owner busy"],
  ["queued work", { queuedWork: "queued" }, "owner busy"],
  ["a background agent", { activity: { activeBackgroundAgentCount: 1 } }, "owner busy"],
  ["a background command", { activity: { activeBackgroundCommandCount: 1 } }, "owner busy"],
  ["a goal", { activity: { activeGoalCount: 1 } }, "owner busy"],
  ["plan mode", { activity: { activePlanModeCount: 1 } }, "owner busy"],
  ["a workflow", { activity: { activeWorkflowCount: 1 } }, "owner busy"],
  ["owner in error", { status: "error" }, "owner in error"],
  ["owner hidden", { visibility: "hidden" }, "owner not eligible"],
] as const;

for (const [name, overrides, reason] of held) {
  test(`held while ${name}, then delivered once it clears`, async () => {
    await watching(async (plugin) => {
      const free = threadRow({ id: THREAD });
      plugin.world.threads.set(THREAD, threadRow({ id: THREAD, ...overrides }));
      plugin.setSnapshot({ ci: failing });
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 0);
      assert.equal((await plugin.status()).bindings[0]?.held, reason);
      plugin.world.threads.set(THREAD, free);
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 1);
      assert.equal((await plugin.status()).bindings[0]?.held, null);
    });
  });
}

test("a stopped child can be woken: a negative test, not status === idle", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD, parentThreadId: "parent", runtime: { displayStatus: "stopped" } }));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("the thread being off holds a delivery that was handed to it", async () => {
  await withPlugin({}, async (plugin) => {
    plugin.world.threads.set("thr_parent", threadRow({ id: "thr_parent" }));
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD, parentThreadId: "thr_parent" }));
    await plugin.claim();
    await plugin.cli(["unwatch", "thr_parent"]);
    await plugin.removeThread("thread.archived", THREAD);
    plugin.settle();
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
    assert.equal((await plugin.status("thr_parent")).bindings[0]?.held, "thread off");
  });
});

test("a running workflow step owned by the owner blocks delivery, through boolean list filters", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set("step", busyRow("step", { lifecycleOwnerThreadId: THREAD, visibility: "hidden", originPluginId: "workflows" }));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
    assert.equal((await plugin.status()).bindings[0]?.held, "work running");
    const inventory = plugin.harness.sdk.callsTo("threads.list").map(([args]) => args as Record<string, unknown>).find((args) => !args["threadIds"]);
    assert.deepEqual(inventory, { projectId: "project-1", includeHidden: true, archived: false });
  });
});

test("a workflow started by a child blocks delivery", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set("child", threadRow({ id: "child", parentThreadId: THREAD }));
    plugin.world.threads.set("step", busyRow("step", { lifecycleOwnerThreadId: "child" }));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
  });
});

test("a workflow started by a workflow step blocks delivery", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set("step", threadRow({ id: "step", lifecycleOwnerThreadId: THREAD }));
    plugin.world.threads.set("inner", busyRow("inner", { lifecycleOwnerThreadId: "step" }));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 0);
  });
});

test("work in an unrelated thread doesn't block delivery", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set("stranger", busyRow("stranger"));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("the 120 s gap between two workflow steps blocks delivery", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set("step-1", busyRow("step-1", { lifecycleOwnerThreadId: THREAD }));
    plugin.setSnapshot({ ci: running, items: [comment("c1")] });
    await plugin.poll();
    assert.equal((await plugin.status()).bindings[0]?.held, "work running");

    plugin.world.threads.set("step-1", threadRow({ id: "step-1", lifecycleOwnerThreadId: THREAD }));
    plugin.advance(60_000);
    await plugin.watcher.tick();
    assert.equal((await plugin.status()).bindings[0]?.held, "quiet time");
    assert.equal(plugin.world.sends.length, 0);

    plugin.advance(60_000);
    await plugin.watcher.tick();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("thread.active and thread.failed restart the quiet time for any thread", async () => {
  for (const event of ["thread.active", "thread.failed"] as const) {
    await watching(async (plugin) => {
      plugin.world.threads.set("step", threadRow({ id: "step", lifecycleOwnerThreadId: THREAD }));
      plugin.setSnapshot({ ci: failing });
      await plugin.emit(event, "step");
      await plugin.watcher.tick();
      assert.equal(plugin.world.sends.length, 0, event);
      assert.equal((await plugin.status()).bindings[0]?.held, "quiet time");
    });
  }
});

test("nothing is sent in the first 120 s after a restart", async () => {
  await watching(async (plugin) => {
    await plugin.restart();
    plugin.setSnapshot({ ci: failing });
    plugin.advance(QUIET_MS - 1);
    await plugin.watcher.tick();
    assert.equal(plugin.world.sends.length, 0);
    assert.equal((await plugin.status()).bindings[0]?.held, "quiet time");
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("held items batch into one message", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD, status: "active" }));
    plugin.setSnapshot({ items: [comment("c1")] });
    await plugin.poll();
    plugin.setSnapshot({ items: [comment("c1"), review("r1")] });
    await plugin.poll();
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD }));
    plugin.settle();
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.match(plugin.sentText(), /issuecomment-c1/);
    assert.match(plugin.sentText(), /pullrequestreview-r1/);
  });
});

test("a missed thread.idle is caught by the next poll", async () => {
  await watching(async (plugin) => {
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD, status: "active" }));
    plugin.setSnapshot({ ci: failing });
    await plugin.poll();
    plugin.world.threads.set(THREAD, threadRow({ id: THREAD }));
    plugin.settle();
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("thread.idle from the owner polls right away, then every minute", async () => {
  await watching(async (plugin) => {
    const polls = () => plugin.world.log.filter((entry) => entry === "host:snapshot").length;
    plugin.world.log.length = 0;
    plugin.setSnapshot({ ci: failing });
    await plugin.emit("thread.idle", THREAD);
    assert.equal(polls(), 1);
    assert.equal((await plugin.status()).bindings[0]?.held, "quiet time");
    plugin.advance(60_000);
    await plugin.watcher.tick();
    assert.equal(polls(), 2);
    plugin.advance(60_000);
    await plugin.watcher.tick();
    assert.equal(plugin.world.sends.length, 1);
  });
});

test("thread.idle from another thread doesn't poll", async () => {
  await watching(async (plugin) => {
    plugin.world.log.length = 0;
    await plugin.emit("thread.idle", "someone-else");
    assert.ok(!plugin.world.log.includes("host:snapshot"));
  });
});

test("the checkout resolving to another PR or to none ends the watch, and nothing is sent", async () => {
  for (const checkout of [{ outcome: "pull_request", url: OTHER_PR }, { outcome: "none" }]) {
    await watching(async (plugin) => {
      plugin.world.checkout = checkout;
      plugin.setSnapshot({ ci: failing });
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 0);
      assert.deepEqual((await plugin.status()).bindings, []);
    });
  }
});

test("a gh error, thrown or returned, holds and doesn't end the watch", async () => {
  for (const checkout of [{ outcome: "failed", code: "failed", message: "not on any branch" }, new Error("host gone")]) {
    await watching(async (plugin) => {
      plugin.world.checkout = checkout as Record<string, unknown>;
      plugin.setSnapshot({ ci: failing });
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 0);
      assert.equal((await plugin.status()).bindings[0]?.held, "checkout unresolved");
      plugin.world.checkout = { outcome: "pull_request", url: PR };
      await plugin.poll();
      assert.equal(plugin.world.sends.length, 1);
    });
  }
});

test("a watch that isn't branch-bound never runs the check", async () => {
  await withPlugin({}, async (plugin) => {
    plugin.world.checkout = { outcome: "pull_request", url: OTHER_PR };
    await plugin.claim({ pr: PR });
    plugin.settle();
    plugin.setSnapshot({ ci: failing });
    plugin.world.log.length = 0;
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 1);
    assert.ok(!plugin.world.log.includes("host:checkout"));
  });
});

test("no pending report or items: no checkout check and no send", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: running });
    plugin.world.log.length = 0;
    await plugin.poll();
    assert.deepEqual(plugin.world.log, ["threads.list:ids", "host:snapshot"]);
  });
});

test("a transfer or unwatch while a send is pending waits in the PR's queue", async () => {
  await watching(async (plugin) => {
    let finish: (value: unknown) => void = () => {};
    plugin.world.sendResult = () => new Promise((resolve) => (finish = resolve));
    plugin.setSnapshot({ ci: failing });
    const polling = plugin.poll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(plugin.world.sends.length, 1);

    let unwatched = false;
    const unwatching = plugin.cli(["unwatch", THREAD]).then(() => (unwatched = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unwatched, false);
    finish({ ok: true, delivery: "sent" });
    await Promise.all([polling, unwatching]);
    assert.deepEqual((await plugin.status()).bindings, []);
  });
});

test("the same PR on a new SHA reports again and the old SHA stays reported", async () => {
  await watching(async (plugin) => {
    plugin.setSnapshot({ ci: failing, headSha: SHA });
    await plugin.poll();
    plugin.setSnapshot({ ci: failing, headSha: NEW_SHA });
    await plugin.poll();
    plugin.setSnapshot({ ci: failing, headSha: SHA });
    await plugin.poll();
    assert.equal(plugin.world.sends.length, 2);
  });
});
