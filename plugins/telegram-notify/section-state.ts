// State logic of the Chats section, kept free of React so it can be tested
// without a DOM. A row is what the user is editing; the status next to it is
// what the server last said about one chat ID.
import type { ChatList, ChatRow } from "./contract.ts";
import {
  CHAT_ID_ERROR,
  MAX_CHATS,
  NAME_MAX,
  listError,
  nameError,
  parseChatId,
  truncate,
  useError,
  type ChatStatus,
} from "./rules.ts";

export interface RowStatus {
  /** The chat ID this status is about. It stops showing once the ID is edited. */
  forChatId: string;
  status: ChatStatus;
  reason?: string;
  migrateToChatId?: string;
}

export interface DraftRow {
  key: string;
  name: string;
  chatId: string;
  use: string;
  /** The ID the server has saved for this row; null for a row added here. */
  savedChatId: string | null;
  info: RowStatus | null;
}

export interface FoundGroup {
  chatId: string;
  title: string;
  type: string;
}

export function newKey(counter: { next: number }): string {
  counter.next += 1;
  return `row-${counter.next}`;
}

function statusOf(chat: ChatRow): RowStatus {
  return {
    forChatId: chat.chatId,
    status: chat.status,
    ...(chat.reason ? { reason: chat.reason } : {}),
    ...(chat.migrateToChatId ? { migrateToChatId: chat.migrateToChatId } : {}),
  };
}

export function rowsFromList(list: ChatList, counter: { next: number }): DraftRow[] {
  return list.chats.map((chat) => ({
    key: newKey(counter),
    name: chat.name,
    chatId: chat.chatId,
    use: chat.use,
    savedChatId: chat.chatId,
    info: statusOf(chat),
  }));
}

/** What to show next to a row: its status, unless the ID was edited since. */
export function visibleStatus(row: DraftRow): RowStatus | null {
  return row.info && row.info.forChatId === row.chatId.trim() ? row.info : null;
}

/**
 * A realtime refresh: take the new statuses and leave names, IDs and notes the
 * user is typing alone.
 */
export function applyStatusRefresh(rows: DraftRow[], list: ChatList): DraftRow[] {
  const byId = new Map(list.chats.map((chat) => [chat.chatId, chat]));
  return rows.map((row) => {
    const chat = row.savedChatId === null ? undefined : byId.get(row.savedChatId);
    return chat ? { ...row, info: statusOf(chat) } : row;
  });
}

export function setRowStatus(
  rows: DraftRow[],
  key: string,
  result: { status: ChatStatus; reason?: string },
  chatId: string,
): DraftRow[] {
  return rows.map((row) =>
    row.key === key
      ? { ...row, info: { forChatId: chatId, status: result.status, ...(result.reason ? { reason: result.reason } : {}) } }
      : row,
  );
}

/** A name for a found group: its title, cut to fit and made unique among the rows. */
export function suggestName(title: string, rows: readonly DraftRow[]): string {
  const taken = new Set(rows.map((row) => row.name.trim().toLowerCase()));
  const base = truncate(title.replace(/\s+/g, " ").trim(), NAME_MAX) || "Group";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${truncate(base, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export type AddResult = { ok: true; rows: DraftRow[]; key: string } | { ok: false; error: string };

/** Picking a found group adds a row with its ID filled in and the title as the suggested name. */
export function addFoundGroup(rows: DraftRow[], group: FoundGroup, counter: { next: number }): AddResult {
  if (rows.length >= MAX_CHATS) {
    return { ok: false, error: `At most ${MAX_CHATS} chats; remove one first.` };
  }
  if (rows.some((row) => row.chatId.trim() === group.chatId)) {
    return { ok: false, error: "That group is already in the table." };
  }
  const key = newKey(counter);
  const row: DraftRow = {
    key,
    name: suggestName(group.title, rows),
    chatId: group.chatId,
    use: "",
    savedChatId: null,
    info: null,
  };
  return { ok: true, rows: [...rows, row], key };
}

export function addBlankRow(rows: DraftRow[], counter: { next: number }): DraftRow[] {
  if (rows.length >= MAX_CHATS) return rows;
  return [...rows, { key: newKey(counter), name: "", chatId: "", use: "", savedChatId: null, info: null }];
}

/** **Use new ID**: fills the migrated ID into the row. It takes effect when the user saves. */
export function useNewId(rows: DraftRow[], key: string): DraftRow[] {
  return rows.map((row) => {
    const info = visibleStatus(row);
    return row.key === key && info?.migrateToChatId ? { ...row, chatId: info.migrateToChatId } : row;
  });
}

export function moveRow(rows: DraftRow[], index: number, delta: -1 | 1): DraftRow[] {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export type SavePayload =
  | { ok: true; chats: { name: string; chatId: string; use: string }[] }
  | { ok: false; row: number | null; error: string };

/** The same checks the server makes, so a typo doesn't cost a round trip. */
export function buildSavePayload(rows: readonly DraftRow[]): SavePayload {
  const parsed: { name: string; chatId: number }[] = [];
  const chats: { name: string; chatId: string; use: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();
    const use = row.use.trim();
    const chatId = row.chatId.trim();
    const id = parseChatId(chatId);
    const error = nameError(name) ?? (id === null ? CHAT_ID_ERROR : null) ?? useError(use);
    if (error || id === null) return { ok: false, row: index, error: error ?? CHAT_ID_ERROR };
    parsed.push({ name, chatId: id });
    chats.push({ name, chatId, use });
  }
  if (rows.length > MAX_CHATS) {
    return { ok: false, row: null, error: `At most ${MAX_CHATS} chats; remove ${rows.length - MAX_CHATS}.` };
  }
  const problem = listError(parsed);
  if (problem) return { ok: false, row: problem.row, error: problem.error };
  return { ok: true, chats };
}

export type TopNotice = "no-token" | "no-chats" | "all-invalid";

/** The notices shown above the table: the tool is not offered in any of these cases. */
export function topNotice(rows: readonly DraftRow[], tokenSet: boolean): TopNotice | null {
  if (!tokenSet) return "no-token";
  if (rows.length === 0) return "no-chats";
  const saved = rows.filter((row) => row.savedChatId !== null);
  if (saved.length === rows.length && saved.every((row) => visibleStatus(row)?.status === "invalid")) {
    return "all-invalid";
  }
  return null;
}
