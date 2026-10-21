// Chat rules shared by the server, the RPC contract and the Chats section.
// No SDK imports, so the app bundle can use it.

export const MAX_CHATS = 10;
export const NAME_MAX = 32;
export const USE_MAX = 120;
/** Telegram chat IDs have at most 52 significant bits; 16 digits can still overflow a double. */
export const CHAT_ID_PATTERN = /^-?\d{1,16}$/;

const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type ChatStatus = "ready" | "invalid" | "unknown";

export function charLength(text: string): number {
  return [...text].length;
}

export function isOneLine(text: string): boolean {
  return !CONTROL_OR_LINE_BREAK.test(text);
}

/** Collapses every run of whitespace and control characters to one space. */
export function toOneLine(text: string): string {
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

/** Cuts to `max` characters (code points), ending in an ellipsis when it cut. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** A decimal chat ID as a safe, nonzero integer; null when it isn't one. */
export function parseChatId(text: string): number | null {
  if (!CHAT_ID_PATTERN.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value === 0) return null;
  return value;
}

export function nameError(name: string): string | null {
  if (name.length === 0) return "Give the chat a name.";
  if (charLength(name) > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`;
  if (!isOneLine(name)) return "Names must be a single line.";
  return null;
}

export function useError(use: string): string | null {
  if (charLength(use) > USE_MAX) return `"When to use" is at most ${USE_MAX} characters.`;
  if (!isOneLine(use)) return `"When to use" must be a single line.`;
  return null;
}

export const CHAT_ID_ERROR = "Chat IDs are whole numbers, such as -1001234567890.";

export interface ListError {
  /** 0-based row of the first problem. */
  row: number;
  error: string;
}

/**
 * The checks a schema can't express: the size of the list and duplicate names
 * or IDs. Reports the first problem, in row order.
 */
export function listError(chats: readonly { name: string; chatId: number }[]): ListError | null {
  if (chats.length > MAX_CHATS) {
    return { row: MAX_CHATS, error: `At most ${MAX_CHATS} chats; remove ${chats.length - MAX_CHATS}.` };
  }
  const names = new Map<string, number>();
  const ids = new Map<number, number>();
  for (const [row, chat] of chats.entries()) {
    const key = chat.name.toLowerCase();
    const sameName = names.get(key);
    if (sameName !== undefined) {
      return {
        row,
        error: `"${chat.name}" is already used by row ${sameName + 1}; names must be unique, ignoring case.`,
      };
    }
    const sameId = ids.get(chat.chatId);
    if (sameId !== undefined) {
      return { row, error: `Chat ID ${chat.chatId} is already used by row ${sameId + 1}.` };
    }
    names.set(key, row);
    ids.set(chat.chatId, row);
  }
  return null;
}
