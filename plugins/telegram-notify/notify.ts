// The `telegram_notify` agent tool: validation, the per-thread cooldown and the
// global hourly cap (reserved in one SQLite transaction before Telegram is
// called), the message format, and the mapping of Telegram's answers.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ChatBook, Db, StoredChat } from "./chats.ts";
import { charLength, isOneLine, toOneLine, truncate } from "./rules.ts";
import { escapeHtml, isTemporary, sendMessage, type TelegramConfig } from "./telegram.ts";

export const TITLE_MAX = 80;
export const MESSAGE_MAX = 1000;
const NAME_IN_FOOTER_MAX = 64;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const INSTRUCTIONS_MAX = 4096;

export const TOOL_NAME = "telegram_notify";

export const TOOL_DESCRIPTION =
  "Send the user a Telegram message with a title and a link back to this thread.";

export const TOOL_INSTRUCTIONS = [
  "Use `telegram_notify` to message the user on their phone when something deserves attention away from the screen:",
  "a requested report or long task is done, you found something they should know soon, or you are blocked on them.",
  "Don't use it for routine replies, progress updates, or anything the user is watching live.",
  "One message per task is typical. Never include secrets, tokens, passwords, or private keys.",
].join(" ");

export const parameters = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .refine((text) => charLength(text) <= TITLE_MAX, `At most ${TITLE_MAX} characters.`)
    .refine(isOneLine, "Must be a single line.")
    .describe("Short headline, one line, at most 80 characters"),
  message: z
    .string()
    .trim()
    .min(1)
    .refine((text) => charLength(text) <= MESSAGE_MAX, `At most ${MESSAGE_MAX} characters.`)
    .describe("The message, at most 1000 characters"),
  chat: z
    .string()
    .optional()
    .describe("Name of the chat to post to, from the list above; omit it for the first chat"),
  silent: z
    .boolean()
    .default(false)
    .describe("Deliver without a sound or vibration, for messages that are only FYI"),
});

/** The chat list the tool adds to a thread's instructions. Names and notes are user text: one plain line each. */
export function buildInstructions(chats: readonly StoredChat[]): string {
  const lines = chats.map((chat) => {
    const name = toOneLine(chat.name);
    const use = toOneLine(chat.use);
    return use ? `- ${name}: ${use}` : `- ${name}`;
  });
  const text = [
    "Telegram chats (pass the name as `chat`; omit it for the first):",
    ...lines,
    "",
    "Only post to a chat what its note says it's for.",
  ].join("\n");
  return text.length > INSTRUCTIONS_MAX ? `${text.slice(0, INSTRUCTIONS_MAX - 1)}…` : text;
}

export function formatMessage(input: {
  title: string;
  message: string;
  project: string;
  thread: string;
}): string {
  // Cut first, escape second: escaping can't leave half an entity behind.
  const title = escapeHtml(truncate(input.title, TITLE_MAX));
  const message = escapeHtml(truncate(input.message, MESSAGE_MAX));
  const project = escapeHtml(truncate(toOneLine(input.project), NAME_IN_FOOTER_MAX));
  const thread = escapeHtml(truncate(toOneLine(input.thread), NAME_IN_FOOTER_MAX));
  return `🔔 <b>${title}</b>\n${message}\n\n<i>${project} · ${thread}</i>`;
}

export function threadUrl(appUrl: string | null, projectId: string, threadId: string): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function clock(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export interface NotifyDeps {
  book: ChatBook;
  db: Db;
  /** Null when no token is set. */
  telegram: TelegramConfig | null;
  cooldownMinutes: number;
  hourlyLimit: number;
  now(): number;
  log: { warn(message: string): void };
}

export function registerNotifyTool(bb: BbPluginApi, deps: NotifyDeps): void {
  const { book, db } = deps;
  const dropOld = db.prepare("DELETE FROM sends WHERE at < ?");
  const lastSend = db.prepare("SELECT MAX(at) AS at FROM sends WHERE thread_id = ?");
  const sendsSince = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE at > ?");
  const reserve = db.prepare("INSERT INTO sends (thread_id, chat_id, at) VALUES (?, ?, ?)");
  const release = db.prepare("DELETE FROM sends WHERE rowid = ?");

  /** Check the limits and insert the reservation, atomically. Returns the row, or the refusal. */
  const reserveSlot = db.transaction((threadId: string, chatId: number): { rowid: number } | { error: string } => {
    const now = deps.now();
    dropOld.run(now - DAY_MS);
    const cooldownMs = deps.cooldownMinutes * 60_000;
    const last = (lastSend.get(threadId) as { at: number | null }).at;
    if (cooldownMs > 0 && last !== null && now - last < cooldownMs) {
      const ago = Math.max(1, Math.round((now - last) / 60_000));
      return {
        error: `cooldown: Sent one for this thread ${ago} minute${ago === 1 ? "" : "s"} ago; try again after ${clock(last + cooldownMs)} or put it in your reply.`,
      };
    }
    const recent = (sendsSince.get(now - HOUR_MS) as { n: number }).n;
    if (recent >= deps.hourlyLimit) {
      return {
        error: `hourly_limit: ${deps.hourlyLimit} messages went out in the last hour; put it in your reply instead.`,
      };
    }
    return { rowid: Number(reserve.run(threadId, chatId, now).lastInsertRowid) };
  });

  bb.agents.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    instructions: TOOL_INSTRUCTIONS,
    parameters,
    async execute(params, ctx) {
      const config = deps.telegram;
      if (!config || !book.tokenAccepted) {
        return failure("not_configured: The Telegram bot token is missing or was rejected. Tell the user; nothing was sent.");
      }

      const chats = book.chatList;
      let chat: StoredChat | undefined;
      if (params.chat !== undefined && params.chat.trim() !== "") {
        chat = book.findByName(params.chat);
        if (!chat) {
          const names = chats.map((entry) => toOneLine(entry.name)).join(", ");
          return failure(`unknown_chat: No chat named ${toOneLine(params.chat)}. Chats: ${names || "none"}.`);
        }
      } else {
        chat = chats[0];
        if (!chat) return failure("unknown_chat: No chats are set up.");
      }
      const status = book.statusOf(chat);
      if (status.status === "invalid") {
        return failure(`chat_invalid: ${status.reason ?? `${chat.name} can't be used.`}`);
      }

      const [thread, project] = await Promise.all([
        bb.sdk.threads.get({ threadId: ctx.threadId }).catch((error: unknown) => {
          deps.log.warn(`Thread lookup failed: ${error instanceof Error ? error.name : "error"}`);
          return null;
        }),
        bb.sdk.projects.get({ projectId: ctx.projectId }).catch((error: unknown) => {
          deps.log.warn(`Project lookup failed: ${error instanceof Error ? error.name : "error"}`);
          return null;
        }),
      ]);
      const threadTitle = thread?.title || thread?.titleFallback || "Untitled thread";
      const projectName = project?.name || "Unknown project";

      const slot = reserveSlot(ctx.threadId, chat.chatId);
      if ("error" in slot) return failure(slot.error);

      const url = threadUrl(bb.server.experimental_appUrl, ctx.projectId, ctx.threadId);
      const result = await sendMessage(
        config,
        {
          chatId: chat.chatId,
          html: formatMessage({ title: params.title, message: params.message, project: projectName, thread: threadTitle }),
          silent: params.silent,
          ...(url ? { button: { text: "Open in bb", url } } : {}),
        },
        ctx.signal,
      );

      if (result.ok) return `Sent to ${chat.name}.`;

      // Nothing reached the chat unless Telegram never answered (or failed on its side).
      if (result.migrateToChatId !== undefined) {
        release.run(slot.rowid);
        const reason = book.markMigrated(chat, result.migrateToChatId);
        return failure(`rejected ${reason}. Nothing was sent.`);
      }
      if (result.errorCode === 429) {
        release.run(slot.rowid);
        const seconds = result.retryAfter ?? 1;
        return failure(
          `rate_limited ${seconds}: Try again after ${seconds} seconds or put it in your reply. Nothing was sent.`,
        );
      }
      if (result.errorCode === 401) {
        release.run(slot.rowid);
        book.rejectToken();
        return failure("not_configured: Telegram rejected the bot token. Tell the user; nothing was sent.");
      }
      if (isTemporary(result)) {
        deps.log.warn(`Send to a chat got no answer (${result.errorCode ?? "no response"}).`);
        return failure(
          "uncertain: The request went out but no answer came back, so the message may have arrived. Don't retry; mention it in your reply.",
        );
      }
      release.run(slot.rowid);
      deps.log.warn(`Telegram refused a send: ${result.errorCode} ${result.description}`);
      return failure(`rejected ${truncate(toOneLine(result.description), 200)}. Nothing was sent.`);
    },
  });
}
