// Ownership through its own interface, with fake ports, for orderings the plugin harness can't stage.
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG } from "./config.ts";
import type { PullRequestRef, Snapshot } from "./contract.ts";
import { Ownership, type ThreadFacts } from "./ownership.ts";
import { MIGRATIONS, Store } from "./store.ts";
import { OTHER_PR, PR, snapshot } from "./test-support.ts";

const facts = (id: string): ThreadFacts => ({
  id,
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  originPluginId: null,
  parentThreadId: null,
  environmentId: "env",
});

function setup(onSnapshot: (pr: PullRequestRef) => Promise<void> = async () => {}) {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const store = new Store(db);
  const tails = new Map<string, Promise<unknown>>();
  const ownership = new Ownership({
    store,
    queue: <T>(prUrl: string, task: () => Promise<T>) => {
      const run = (tails.get(prUrl) ?? Promise.resolve()).then(task);
      tails.set(prUrl, run.catch(() => undefined));
      return run;
    },
    loadFacts: async (id) => facts(id),
    readEnvironment: async () => ({ ready: true, path: "/work", hostId: "host" }),
    readCheckout: async () => ({ url: null }),
    snapshot: async (pr) => {
      await onSnapshot(pr);
      const url = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
      return { outcome: "snapshot", snapshot: snapshot({ url } as Partial<Snapshot>) };
    },
    config: () => DEFAULT_CONFIG,
    now: () => 1,
    log: { info() {}, warn() {}, error() {} },
    remember() {},
    forgetHeld() {},
    end: (prUrl) => store.drop(prUrl),
  });
  return { store, ownership };
}

test("moveAll skips a watch that another thread claimed while earlier moves were waiting", async () => {
  let interfere: (() => Promise<unknown>) | null = null;
  const { store, ownership } = setup(async (pr) => {
    // When the move reaches the second PR, another thread claims it first.
    if (pr.number === 43 && interfere) {
      const run = interfere;
      interfere = null;
      await run();
    }
  });
  await ownership.claim("thr_child", "agent", PR);
  await ownership.claim("thr_child", "agent", OTHER_PR);
  interfere = () => ownership.claim("thr_third", "user", OTHER_PR);

  const outcome = await ownership.moveAll("thr_child", "thr_parent", "user");
  assert.ok(outcome.kind === "moved");
  assert.deepEqual(
    outcome.results.map(({ prUrl, outcome: result }) => [prUrl, result.kind === "refused" ? result.code : result.kind]),
    [
      [PR, "replaced"],
      [OTHER_PR, "owner_changed"],
    ],
  );
  assert.equal(store.binding(PR)?.threadId, "thr_parent");
  assert.equal(store.binding(OTHER_PR)?.threadId, "thr_third");
});
