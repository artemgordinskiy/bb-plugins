// Shared test fixtures: a fake Telegram Bot API behind the injected `fetch`,
// and a booted plugin on the SDK's fake host. Tokens and chat IDs are made up.
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import type { ChatBook } from "./chats.ts";
import { setup } from "./server.ts";

export const TOKEN = "123456:FAKE-token-for-tests";
export const BOT_ID = 4242;

export type Reply =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; code: number; description: string; parameters?: Record<string, unknown> }
  | { kind: "network" }
  /** A 2xx whose body isn't JSON, or is cut off mid-stream. */
  | { kind: "unreadable"; cutOff: boolean }
  | { kind: "hang" };

export const ok = (result: unknown = true): Reply => ({ kind: "ok", result });
export const fail = (code: number, description: string, parameters?: Record<string, unknown>): Reply => ({
  kind: "error",
  code,
  description,
  ...(parameters ? { parameters } : {}),
});
export const network = (): Reply => ({ kind: "network" });
export const garbled = (): Reply => ({ kind: "unreadable", cutOff: false });
export const cutOff = (): Reply => ({ kind: "unreadable", cutOff: true });
export const hang = (): Reply => ({ kind: "hang" });

export interface FakeChat {
  type?: string;
  title?: string;
  is_forum?: boolean;
  /** The group's default permissions. */
  canSend?: boolean | undefined;
  /** The bot's membership. */
  member?: { status: string; is_member?: boolean; can_send_messages?: boolean };
}

export interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** A Bot API that knows a few chats; `on` overrides single methods for a test. */
export class FakeTelegram {
  readonly calls: Call[] = [];
  readonly chats = new Map<number, FakeChat>();
  updates: unknown[] = [];
  private overrides = new Map<string, (body: Record<string, unknown>) => Reply | undefined>();
  /** Token the fake accepts; anything else gets a 401. */
  acceptedToken = TOKEN;

  /** A healthy group where the bot is an ordinary member and members can post. */
  addGroup(id: number, chat: FakeChat = {}): this {
    this.chats.set(id, {
      type: "supergroup",
      title: `Group ${id}`,
      canSend: true,
      member: { status: "member" },
      ...chat,
    });
    return this;
  }

  on(method: string, handler: (body: Record<string, unknown>) => Reply | undefined): this {
    this.overrides.set(method, handler);
    return this;
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private answer(method: string, body: Record<string, unknown>): Reply {
    const custom = this.overrides.get(method)?.(body);
    if (custom) return custom;
    const chat = this.chats.get(Number(body.chat_id));
    const missing = fail(400, "Bad Request: chat not found");
    switch (method) {
      case "getMe":
        return ok({ id: BOT_ID, is_bot: true, username: "fake_bot" });
      case "getChat":
        return chat
          ? ok({
              id: Number(body.chat_id),
              type: chat.type,
              title: chat.title,
              ...(chat.is_forum ? { is_forum: true } : {}),
              ...(chat.canSend === undefined ? {} : { permissions: { can_send_messages: chat.canSend } }),
            })
          : missing;
      case "getChatMember":
        return chat ? ok(chat.member ?? { status: "member" }) : missing;
      case "getUpdates":
        return ok(this.updates);
      case "sendMessage":
        return chat ? ok({ message_id: 1 }) : missing;
      default:
        return fail(404, "Not Found");
    }
  }

  /** The `fetch` handed to the plugin. */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!match) throw new Error(`unexpected URL ${url}`);
    const [, token, method] = match;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    this.calls.push({ method: method!, body });
    const reply: Reply =
      token === this.acceptedToken ? this.answer(method!, body) : fail(401, "Unauthorized");
    switch (reply.kind) {
      case "ok":
        return Response.json({ ok: true, result: reply.result });
      case "error":
        return Response.json(
          { ok: false, error_code: reply.code, description: reply.description, parameters: reply.parameters },
          { status: reply.code },
        );
      case "network":
        // fetch errors may quote the URL, including the token; the plugin must not pass that on.
        throw new TypeError(`fetch failed: ${url}`);
      case "unreadable":
        if (!reply.cutOff) return new Response("<html>502 from a proxy</html>", { status: 200 });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":tr'));
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        );
      case "hang":
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
    }
  };
}

/** A sleep the test releases by hand, so a backoff loop can't spin. */
export class FakeSleep {
  readonly requested: number[] = [];
  private waiting: (() => void)[] = [];

  readonly sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    this.requested.push(ms);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  release(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

export async function until(condition: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface BootOptions {
  settings?: Record<string, string | number | boolean>;
  appUrl?: string | null;
  tg?: FakeTelegram;
  start?: number;
  timeoutMs?: number;
  threadTitle?: string | null;
  projectName?: string;
}

export async function boot(options: BootOptions = {}) {
  const tg = options.tg ?? new FakeTelegram();
  const clock = { now: options.start ?? Date.UTC(2026, 0, 15, 12, 0, 0) };
  const sleeper = new FakeSleep();
  const { bb, harness } = createFakePluginHost({
    pluginId: "telegram-notify",
    appUrl: options.appUrl === undefined ? "https://bb.example.test" : options.appUrl,
    settings: { botToken: TOKEN, ...options.settings },
  });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
    makeThreadResponse({
      id: args.threadId,
      projectId: "project-test",
      title: options.threadTitle === undefined ? "Fix the build" : options.threadTitle,
    }),
  );
  harness.sdk.stub("projects.get", async () => ({ name: options.projectName ?? "Homelab" }));

  const book: ChatBook = await setup(bb, {
    fetch: tg.fetch,
    now: () => clock.now,
    sleep: sleeper.sleep,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  const service = harness.runService("check");

  /** Waits until the check service has nothing left to check. */
  const settle = () => book.idle();
  const save = (chats: { name: string; chatId: string; use?: string }[]) =>
    harness.callRpc("saveChats", { chats: chats.map((chat) => ({ use: "", ...chat })) });

  return { tg, clock, sleeper, bb, harness, book, service, settle, save };
}

export type Booted = Awaited<ReturnType<typeof boot>>;

export const configContext = (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0] = {}) =>
  makePluginAgentConfigurationContext({
    thread: { parentThreadId: null },
    origin: { pluginId: null },
    ...overrides,
  });

/** Boots the plugin, runs the test, and always shuts the check service down. */
export async function withPlugin(options: BootOptions, run: (plugin: Booted) => Promise<void>): Promise<void> {
  const plugin = await boot(options);
  try {
    await run(plugin);
  } finally {
    await plugin.harness.lifecycle.dispose();
  }
}
