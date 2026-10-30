import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { Check, Snapshot, SnapshotItem, StatusOutput } from "./contract.ts";
import { setup, type Watcher } from "./server.ts";

export const PR = "https://github.com/acme/api/pull/42";
export const OTHER_PR = "https://github.com/acme/api/pull/43";
export const SHA = "abc1234def";
export const NEW_SHA = "fed4321cba";
export const THREAD = "thr_owner";

const MINUTE = 60_000;

type Row = Record<string, unknown> & { id: string };
type HostReply = Record<string, unknown>;
type ListArgs = { threadIds?: string[]; projectId?: string; archived?: boolean; includeHidden?: boolean };
type SendArgs = { threadId: string; input: { text: string }[]; mode: string; originPluginId: string };
type DeleteArgs = { threadId: string; queuedMessageId: string };

export function threadRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    deletedAt: null,
    environmentHostId: "host-1",
    environmentId: "env-1",
    environmentPath: "/work/api",
    hasPendingInteraction: false,
    lifecycleOwnerThreadId: null,
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    projectId: "project-1",
    queuedWork: "none",
    runtime: { displayStatus: "idle" },
    status: "idle",
    title: null,
    visibility: "visible",
    ...overrides,
  };
}

export const check = (overrides: Partial<Check> = {}): Check => ({
  kind: "run",
  name: "tests",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: `${PR}/checks`,
  ...overrides,
});

export const passing: Snapshot["ci"] = { rollup: "SUCCESS", checks: [check()], hasNextPage: false };
export const running: Snapshot["ci"] = {
  rollup: "PENDING",
  checks: [check({ status: "IN_PROGRESS", conclusion: null })],
  hasNextPage: false,
};
export const failing: Snapshot["ci"] = {
  rollup: "FAILURE",
  checks: [check({ name: "lint", conclusion: "FAILURE" })],
  hasNextPage: false,
};

export const comment = (id: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem => ({
  id,
  kind: "comment",
  author: "reviewer",
  authorIsBot: false,
  association: "MEMBER",
  inlineCount: 0,
  at: "2026-10-30T10:00:00Z",
  url: `${PR}#issuecomment-${id}`,
  excerpt: `comment ${id}`,
  ...overrides,
});

export const review = (id: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem => ({
  ...comment(id),
  kind: "review",
  reviewState: "CHANGES_REQUESTED",
  url: `${PR}#pullrequestreview-${id}`,
  ...overrides,
});

export const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  url: PR,
  viewerLogin: "me",
  state: "OPEN",
  isDraft: false,
  title: "Add retry",
  headSha: SHA,
  ci: running,
  items: [],
  ...overrides,
});

class FakeSleep {
  requested: number[] = [];
  private wake: (() => void) | null = null;

  sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    this.requested.push(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  release(): void {
    this.wake?.();
    this.wake = null;
  }
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export type BootOptions = { settings?: Record<string, string> };

/** A plugin with a fake bb and fake gh behind it; every reply can be changed mid-test. */
export async function boot(options: BootOptions = {}) {
  const clock = { now: Date.parse("2026-10-30T12:00:00Z") };
  const sleeper = new FakeSleep();
  const world = {
    threads: new Map<string, Row>([[THREAD, threadRow({ id: THREAD })]]),
    environment: { id: "env-1", hostId: "host-1", path: "/work/api" as string | null, lifecycle: { phase: "active" } },
    host: { id: "host-1", status: "connected", lifecycle: { phase: "active" } },
    checkout: { outcome: "pull_request", url: PR } as HostReply | Error,
    snapshots: new Map<string, Snapshot | HostReply | Error>([[PR, snapshot()]]),
    sendResult: (): unknown => ({ ok: true, delivery: "sent" }),
    deleteResult: (): unknown => ({ ok: true }),
    queue: [] as Row[],
    sends: [] as SendArgs[],
    deletes: [] as DeleteArgs[],
    /** What happens around the send, in order, for tests of the ordering. */
    log: [] as string[],
  };

  const stubbed = <T extends { sdk: { stub(path: string, implementation: (...args: never[]) => unknown): void } }>(harness: T): T => {
    harness.sdk.stub("threads.list", async (args: ListArgs) => {
      world.log.push(args.threadIds ? "threads.list:ids" : "threads.list:inventory");
      const rows = [...world.threads.values()].filter((row) => row["deletedAt"] === null);
      if (args.threadIds) return rows.filter((row) => args.threadIds?.includes(row.id));
      return rows.filter(
        (row) =>
          row["projectId"] === args.projectId &&
          (args.archived !== false || row["archivedAt"] === null) &&
          (args.includeHidden === true || row["visibility"] === "visible"),
      );
    });
    harness.sdk.stub("environments.get", async () => world.environment);
    harness.sdk.stub("hosts.get", async () => world.host);
    harness.sdk.stub("threads.send", async (args: SendArgs) => {
      world.log.push("threads.send");
      world.sends.push(args);
      return world.sendResult();
    });
    harness.sdk.stub("threads.queue.list", async () => world.queue);
    harness.sdk.stub("threads.queuedMessages.delete", async (args: DeleteArgs) => {
      world.deletes.push(args);
      return world.deleteResult();
    });
    return harness;
  };

  const first = createFakePluginHost({
    pluginId: "pr-watcher",
    settings: options.settings ?? {},
    experimental_callHostRpc: async ({ method, input }) => {
      world.log.push(`host:${method}`);
      if (method === "checkout") {
        if (world.checkout instanceof Error) throw world.checkout;
        return world.checkout;
      }
      const { owner, repo, number } = input as { owner: string; repo: string; number: number };
      const reply = world.snapshots.get(`https://github.com/${owner}/${repo}/pull/${number}`);
      if (reply instanceof Error) throw reply;
      if (reply && "outcome" in reply) return reply;
      return reply ? { outcome: "snapshot", snapshot: reply } : { outcome: "failed", code: "not_found", message: "pull request not found" };
    },
  });
  const deps = { now: () => clock.now, sleep: sleeper.sleep };
  let harness = stubbed(first.harness);
  let watcher: Watcher = await setup(first.bb, deps);

  const emit = async (event: "thread.active" | "thread.idle" | "thread.failed", id: string) => {
    const thread = makeThreadResponse({ id });
    if (event === "thread.active") await harness.emitThreadEvent(event, { thread });
    if (event === "thread.idle") await harness.emitThreadEvent(event, { thread, lastAssistantText: null });
    if (event === "thread.failed") await harness.emitThreadEvent(event, { thread, error: null });
  };

  /** Marks the row and fires the event, as bb does. */
  const removeThread = async (event: "thread.archived" | "thread.deleted", id: string) => {
    const row = world.threads.get(id) ?? threadRow({ id });
    const at = clock.now;
    world.threads.set(id, { ...row, ...(event === "thread.archived" ? { archivedAt: at } : { deletedAt: at }) });
    await harness.emitThreadEvent(event, { thread: makeThreadResponse({ id, parentThreadId: row["parentThreadId"] as string | null }) });
  };

  return {
    get harness() {
      return harness;
    },
    get watcher() {
      return watcher;
    },
    world,
    sleeper,
    clock,
    emit,
    removeThread,
    advance: (ms: number) => {
      clock.now += ms;
    },
    /** Moves past the quiet time. */
    settle: () => {
      clock.now += 2 * MINUTE;
    },
    /** Keeps the database and loses everything held in memory. */
    restart: async () => {
      const replacement = await harness.lifecycle.reload(async (bb) => {
        watcher = await setup(bb, deps);
      });
      harness = stubbed(replacement.harness);
      await watcher.startup();
    },
    claim: (input: { pr?: string } = {}, threadId = THREAD) =>
      harness.callAgentTool("pr_watch", input, { threadId, projectId: "project-1" }),
    cli: (argv: string[], ctx: { threadId?: string } = {}) => harness.runCli(argv, ctx),
    setSnapshot: (overrides: Partial<Snapshot>) => world.snapshots.set(PR, snapshot(overrides)),
    /** Polls every PR, as if the clock had passed its next poll. */
    poll: async () => {
      clock.now += 5 * MINUTE;
      await watcher.tick();
    },
    sentText: (index = 0) => world.sends[index]?.input[0]?.text ?? "",
    status: async (thread: string = THREAD): Promise<StatusOutput> => {
      const result = await harness.runCli(["status", thread, "--json"], {});
      return JSON.parse(result.stdout ?? "") as StatusOutput;
    },
  };
}

export type Plugin = Awaited<ReturnType<typeof boot>>;

export async function withPlugin(options: BootOptions, run: (plugin: Plugin) => Promise<void>): Promise<void> {
  const plugin = await boot(options);
  try {
    await run(plugin);
  } finally {
    await plugin.harness.lifecycle.dispose();
  }
}

/** Boots, claims the PR with nothing to report, and passes the quiet time. */
export async function watching(run: (plugin: Plugin) => Promise<void>, options: BootOptions = {}): Promise<void> {
  await withPlugin(options, async (plugin) => {
    await plugin.claim();
    plugin.settle();
    await run(plugin);
  });
}

export function configContext(overrides: Parameters<typeof makePluginAgentConfigurationContext>[0] = {}) {
  return makePluginAgentConfigurationContext({
    thread: { parentThreadId: null },
    origin: { kind: null, pluginId: null },
    ...overrides,
  } as Parameters<typeof makePluginAgentConfigurationContext>[0]);
}
