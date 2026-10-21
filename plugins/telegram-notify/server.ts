// bb-plugin-telegram-notify backend: the `telegram_notify` agent tool, the
// settings (token, cooldown, hourly cap), and the RPC the Chats section uses.
// The chat list lives in SQLite and is edited only in that section.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ChatBook, MIGRATIONS } from "./chats.ts";
import { contract } from "./contract.ts";
import { TOOL_NAME, buildInstructions, registerNotifyTool } from "./notify.ts";
import type { Fetch, TelegramConfig } from "./telegram.ts";

/** Everything that touches the outside world, so tests can replace it. */
export interface Deps {
  fetch: Fetch;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Per-request timeout for the Bot API. */
  timeoutMs: number;
}

export const realDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
  timeoutMs: 10_000,
};

export async function setup(bb: BbPluginApi, deps: Deps): Promise<ChatBook> {
  const settings = bb.settings.define({
    botToken: {
      type: "string",
      label: "Bot token",
      description: "From @BotFather. Stored as a private file on the bb server, never shown again. Reload the plugin after changing it.",
      secret: true,
    },
    cooldownMinutes: {
      type: "select",
      label: "Cooldown per thread (minutes)",
      description: "The least time between two messages from the same thread; 0 turns it off. Reload the plugin after changing it.",
      options: ["0", "1", "5", "15", "60"],
      default: "5",
    },
    hourlyLimit: {
      type: "number",
      label: "Messages per hour",
      description: "The most messages all threads together may send in an hour. Reload the plugin after changing it.",
      experimental_schema: z.number().int().min(1).max(100),
      default: 20,
    },
  });
  // Settings take effect on reload, so they are read once.
  const values = await settings.get();
  const token = values.botToken?.trim() || null;
  const cooldownMinutes = Number(values.cooldownMinutes);
  const hourlyLimit = values.hourlyLimit;

  if (!token) {
    bb.status.needsConfiguration("Set the Telegram bot token in the settings, then reload the plugin.");
  }
  const telegram: TelegramConfig | null = token
    ? { token, fetch: deps.fetch, timeoutMs: deps.timeoutMs }
    : null;

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const book = new ChatBook({
    db,
    telegram,
    log: bb.log,
    publish: () => bb.realtime.publish("chats", {}),
    needsConfiguration: (message) => bb.status.needsConfiguration(message),
    sleep: deps.sleep,
  });

  bb.onDispose(() => book.dispose());

  registerNotifyTool(bb, {
    book,
    db,
    telegram,
    cooldownMinutes,
    hourlyLimit,
    now: deps.now,
    log: bb.log,
  });

  // Top-level threads only: workers report to their parent, and a side chat is a scratchpad.
  bb.agents.configure((ctx) =>
    book.usable && ctx.thread.parentThreadId === null && ctx.origin.pluginId !== "side-chat"
      ? { tools: [TOOL_NAME], skills: [], instructions: buildInstructions(book.chatList) }
      : { tools: [], skills: [] },
  );

  bb.rpc.register(contract, {
    listChats: () => book.list(),
    saveChats: ({ chats }) => book.save(chats),
    checkChat: async ({ chatId }) => {
      const { status, reason, title } = await book.checkChat(chatId);
      return { status, ...(reason ? { reason } : {}), ...(title ? { title } : {}) };
    },
    findGroups: () => book.findGroups(),
  });

  bb.background.service("check", {
    start: (signal) => book.serve(signal),
  });

  return book;
}

export default async function plugin(bb: BbPluginApi) {
  await setup(bb, realDeps);
}
