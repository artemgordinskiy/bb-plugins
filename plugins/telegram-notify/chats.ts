// The chat list, its check statuses and everything that talks to Telegram
// about them. `agents.configure` is synchronous, so the list and the statuses
// live in memory: loaded from SQLite at start, replaced on every save or check.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ChatList, ChatRow } from "./contract.ts";
import { MAX_CHATS, listError, toOneLine, truncate, type ChatStatus } from "./rules.ts";
import {
  getChat,
  getChatMember,
  getMe,
  getUpdates,
  isTemporary,
  type ApiFailure,
  type TelegramConfig,
} from "./telegram.ts";

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

export interface StoredChat {
  name: string;
  chatId: number;
  use: string;
}

export interface StatusInfo {
  status: ChatStatus;
  reason?: string;
  /** Telegram said the group is now a supergroup under this ID. */
  migrateToChatId?: number;
}

export interface Outcome extends StatusInfo {
  title?: string;
}

export type SaveResult =
  | { ok: true; list: ChatList }
  | { ok: false; row: number | null; error: string };

export interface ChatBookDeps {
  db: Db;
  /** Null when no token is set. */
  telegram: TelegramConfig | null;
  log: { info(message: string): void; warn(message: string): void };
  /** Called whenever a chat's status changed. */
  publish(): void;
  needsConfiguration(message: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const MIGRATIONS = [
  `CREATE TABLE chats (
    name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
    chat_id INTEGER NOT NULL UNIQUE,
    use TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL UNIQUE
  )`,
  `CREATE TABLE sends (
    thread_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX sends_thread_at ON sends (thread_id, at)",
];

const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const NOT_CHECKED = "Not checked yet.";
const NO_TOKEN = "Bot token not set.";
const TOKEN_REJECTED = "Telegram rejected the bot token. Replace it above, then reload the plugin.";

/** One line of Telegram's text, short enough for a status cell or a tool result. */
export function describe(text: string): string {
  return truncate(toOneLine(text), 200);
}

export class ChatBook {
  private chats: StoredChat[];
  private statuses = new Map<number, StatusInfo>();
  /** Bumped when a chat's status is decided some other way, so an older in-flight check is dropped. */
  private generations = new Map<number, number>();
  private tokenRejected = false;
  private wakeResolvers: (() => void)[] = [];
  private idleResolvers: (() => void)[] = [];
  private settled = false;
  private disposed = false;

  private readonly deps: ChatBookDeps;

  constructor(deps: ChatBookDeps) {
    this.deps = deps;
    this.chats = (
      deps.db
        .prepare("SELECT name, chat_id AS chatId, use FROM chats ORDER BY position")
        .all() as StoredChat[]
    ).map((row) => ({ name: row.name, chatId: row.chatId, use: row.use }));
    for (const chat of this.chats) this.statuses.set(chat.chatId, { status: "unknown", reason: NOT_CHECKED });
  }

  /** After a reload the old SDK handle is stale: stop publishing and stop reporting. */
  dispose(): void {
    this.disposed = true;
  }

  private emit(): void {
    if (!this.disposed) this.deps.publish();
  }

  // --- reading ---------------------------------------------------------

  get tokenSet(): boolean {
    return this.deps.telegram !== null;
  }

  get tokenAccepted(): boolean {
    return this.deps.telegram !== null && !this.tokenRejected;
  }

  get chatList(): readonly StoredChat[] {
    return this.chats;
  }

  /** What the section and the tool see for one chat. */
  statusOf(chat: StoredChat): StatusInfo {
    if (!this.deps.telegram) return { status: "unknown", reason: NO_TOKEN };
    if (this.tokenRejected) return { status: "unknown", reason: TOKEN_REJECTED };
    return this.statuses.get(chat.chatId) ?? { status: "unknown", reason: NOT_CHECKED };
  }

  /** The tool is offered when the token is accepted and some chat isn't invalid. */
  get usable(): boolean {
    if (!this.deps.telegram || this.tokenRejected) return false;
    return this.chats.some((chat) => this.statusOf(chat).status !== "invalid");
  }

  findByName(name: string): StoredChat | undefined {
    const wanted = name.trim().toLowerCase();
    return this.chats.find((chat) => chat.name.toLowerCase() === wanted);
  }

  list(): ChatList {
    return { tokenSet: this.tokenSet, chats: this.chats.map((chat) => this.row(chat)) };
  }

  private row(chat: StoredChat): ChatRow {
    const info = this.statusOf(chat);
    return {
      name: chat.name,
      chatId: String(chat.chatId),
      use: chat.use,
      status: info.status,
      ...(info.reason ? { reason: info.reason } : {}),
      ...(info.migrateToChatId !== undefined ? { migrateToChatId: String(info.migrateToChatId) } : {}),
    };
  }

  // --- saving ----------------------------------------------------------

  save(chats: StoredChat[]): SaveResult {
    if (chats.length > MAX_CHATS) {
      return { ok: false, row: null, error: `At most ${MAX_CHATS} chats; remove ${chats.length - MAX_CHATS}.` };
    }
    const problem = listError(chats);
    if (problem) return { ok: false, row: problem.row, error: problem.error };

    const { db } = this.deps;
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM chats").run();
        const insert = db.prepare("INSERT INTO chats (name, chat_id, use, position) VALUES (?, ?, ?, ?)");
        for (const [position, chat] of chats.entries()) {
          insert.run(chat.name, chat.chatId, chat.use, position);
        }
      })();
    } catch (error) {
      this.deps.log.warn(`Saving chats failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return { ok: false, row: null, error: "Couldn't save the chats. Nothing was changed." };
    }

    // Memory follows the database only after the commit.
    const previous = this.statuses;
    this.chats = chats.map((chat) => ({ ...chat }));
    this.statuses = new Map();
    for (const chat of this.chats) {
      this.statuses.set(chat.chatId, previous.get(chat.chatId) ?? { status: "unknown", reason: NOT_CHECKED });
      if (!previous.has(chat.chatId)) this.bump(chat.chatId);
    }
    this.emit();
    this.wake();
    return { ok: true, list: this.list() };
  }

  // --- checking --------------------------------------------------------

  /** The Check button: one chat, any ID. Only a saved chat's stored status changes. */
  async checkChat(chatId: number): Promise<Outcome> {
    const config = this.deps.telegram;
    if (!config) return { status: "unknown", reason: NO_TOKEN };
    this.bump(chatId);
    return (await this.round(config, [chatId])).get(chatId) as Outcome;
  }

  /** Checks several chats with one `getMe`; stale results (a newer decision exists) are dropped. */
  private async round(config: TelegramConfig, ids: number[]): Promise<Map<number, Outcome>> {
    const outcomes = new Map<number, Outcome>();
    const started = new Map(ids.map((id) => [id, this.generation(id)]));
    const finish = (id: number, outcome: Outcome) => {
      outcomes.set(id, outcome);
      if (this.generation(id) === started.get(id)) this.apply(id, outcome);
    };

    const me = await getMe(config);
    if (!me.ok) {
      const outcome = this.fromFailure(me);
      for (const id of ids) finish(id, outcome);
      return outcomes;
    }
    for (const id of ids) {
      finish(id, await this.evaluate(config, id, me.result.id));
    }
    return outcomes;
  }

  private async evaluate(config: TelegramConfig, chatId: number, botId: number): Promise<Outcome> {
    const chat = await getChat(config, chatId);
    if (!chat.ok) return this.fromFailure(chat);
    const { type, is_forum: isForum, permissions } = chat.result;
    const title = chat.result.title ? truncate(toOneLine(chat.result.title), 128) : undefined;
    const named = (outcome: StatusInfo): Outcome => (title ? { ...outcome, title } : outcome);

    if (type !== "group" && type !== "supergroup") {
      return named({ status: "invalid", reason: `That is a ${describe(type)} chat; only groups and supergroups work.` });
    }
    if (isForum) {
      return named({ status: "invalid", reason: "This group has topics turned on; only groups without topics work." });
    }

    const member = await getChatMember(config, chatId, botId);
    if (!member.ok) return { ...this.fromFailure(member), ...(title ? { title } : {}) };
    const { status, is_member: isMember, can_send_messages: canSend } = member.result;
    if (status === "administrator" || status === "creator") return named({ status: "ready" });
    if (status === "member") {
      return permissions?.can_send_messages === true
        ? named({ status: "ready" })
        : named({ status: "invalid", reason: "Members can't post in this group. Allow sending messages in its permissions." });
    }
    if (status === "restricted") {
      if (!isMember) return named({ status: "invalid", reason: "The bot is restricted and is no longer in this group. Add it again." });
      return canSend === true
        ? named({ status: "ready" })
        : named({ status: "invalid", reason: "The bot is restricted from sending messages in this group." });
    }
    if (status === "left") return named({ status: "invalid", reason: "The bot isn't in this group. Add it to the group." });
    if (status === "kicked") return named({ status: "invalid", reason: "The bot was removed from this group. Add it again." });
    return named({ status: "invalid", reason: `The bot's membership status is "${describe(status)}".` });
  }

  /** Maps a failed Bot API call during a check to a status. */
  private fromFailure(failure: ApiFailure): Outcome {
    if (failure.errorCode === 401) {
      this.rejectToken();
      return { status: "unknown", reason: TOKEN_REJECTED };
    }
    if (isTemporary(failure)) {
      return { status: "unknown", reason: `Couldn't reach Telegram (${describe(failure.description)}). Will retry.` };
    }
    if (failure.errorCode === 400 && /chat not found/i.test(failure.description)) {
      return { status: "invalid", reason: "Chat not found. Check the ID, and that the bot is in the group." };
    }
    if (failure.errorCode === 400 || failure.errorCode === 403) {
      return { status: "invalid", reason: `Telegram refused the check: ${describe(failure.description)}` };
    }
    return { status: "unknown", reason: `Unexpected answer from Telegram: ${describe(failure.description)}. Will retry.` };
  }

  /** Any 401 means the token is dead: say so once and stop checking. */
  rejectToken(): void {
    if (this.tokenRejected) return;
    this.tokenRejected = true;
    if (this.disposed) return;
    this.deps.log.warn("Telegram rejected the bot token.");
    this.deps.needsConfiguration("Telegram rejected the bot token. Update it in the settings, then reload the plugin.");
    this.emit();
  }

  private apply(chatId: number, outcome: Outcome): void {
    if (!this.chats.some((chat) => chat.chatId === chatId)) return;
    const before = this.statuses.get(chatId);
    // A migration notice outlives a re-check that still finds the old chat unusable.
    const keep = outcome.status === "invalid" ? before?.migrateToChatId : undefined;
    const next: StatusInfo = {
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(keep !== undefined ? { migrateToChatId: keep } : {}),
    };
    this.statuses.set(chatId, next);
    if (
      before?.status !== next.status ||
      before?.reason !== next.reason ||
      before?.migrateToChatId !== next.migrateToChatId
    ) {
      this.emit();
    }
  }

  /** A send found that the group moved: refuse the old ID and remember the new one. */
  markMigrated(chat: StoredChat, newChatId: number): string {
    const reason = `${chat.name} moved to chat ID ${newChatId}; update it in Settings → Plugins → Telegram Notify`;
    this.bump(chat.chatId);
    this.statuses.set(chat.chatId, { status: "invalid", reason, migrateToChatId: newChatId });
    this.emit();
    return reason;
  }

  // --- the check service -----------------------------------------------

  private generation(chatId: number): number {
    return this.generations.get(chatId) ?? 0;
  }

  private bump(chatId: number): void {
    this.generations.set(chatId, this.generation(chatId) + 1);
  }

  private pendingIds(): number[] {
    if (!this.deps.telegram || this.tokenRejected) return [];
    return this.chats.filter((chat) => this.statuses.get(chat.chatId)?.status === "unknown").map((chat) => chat.chatId);
  }

  private wake(): void {
    this.settled = false;
    for (const resolve of this.wakeResolvers.splice(0)) resolve();
  }

  private waitForWake(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      this.wakeResolvers.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /** Checks every unknown chat, then re-checks the ones still unknown with growing pauses (30 s to 15 min). */
  async serve(signal: AbortSignal): Promise<void> {
    const config = this.deps.telegram;
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      const ids = this.pendingIds();
      if (!config || ids.length === 0) {
        delay = BACKOFF_START_MS;
        this.settled = true;
        for (const resolve of this.idleResolvers.splice(0)) resolve();
        await this.waitForWake(signal);
        continue;
      }
      this.settled = false;
      await this.round(config, ids);
      if (this.pendingIds().length > 0) {
        await Promise.race([this.deps.sleep(delay, signal), this.waitForWake(signal)]);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /** Resolves when the service has no unknown chat left to check. For tests. */
  idle(): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  // --- Find groups -----------------------------------------------------

  async findGroups(): Promise<{
    groups: { chatId: string; title: string; type: string }[];
    maybeIncomplete: boolean;
  }> {
    const config = this.deps.telegram;
    if (!config) throw new Error("Set the bot token above and reload the plugin first.");
    const updates = await getUpdates(config);
    if (!updates.ok) {
      if (updates.errorCode === 401) {
        this.rejectToken();
        throw new Error(TOKEN_REJECTED);
      }
      if (updates.network) throw new Error(`Couldn't reach Telegram: ${describe(updates.description)}`);
      // A 409 is shown as Telegram wrote it: a webhook is set or another consumer is polling.
      throw new Error(toOneLine(updates.description));
    }

    // Oldest first, so the last update per chat wins.
    const latest = new Map<number, { status: string; type: string; title: string }>();
    for (const update of updates.result) {
      const change = update.my_chat_member;
      if (!change) continue;
      latest.set(change.chat.id, {
        status: change.new_chat_member.status,
        type: change.chat.type,
        title: change.chat.title ?? "",
      });
    }
    const listed = new Set(this.chats.map((chat) => chat.chatId));
    const groups = [...latest.entries()]
      .filter(([id]) => !listed.has(id))
      .filter(([, change]) => change.status === "member" || change.status === "administrator")
      .filter(([, change]) => change.type === "group" || change.type === "supergroup")
      .map(([id, change]) => ({
        chatId: String(id),
        title: truncate(toOneLine(change.title), 128) || String(id),
        type: change.type,
      }));
    return { groups, maybeIncomplete: updates.result.length >= 100 };
  }
}
