// Minimal Telegram Bot API client. `fetch` is injected so tests never reach
// the network. The bot token is part of every request URL, so nothing that
// leaves this module (results, errors, log text) may contain it.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramConfig {
  token: string;
  fetch: Fetch;
  /** Per-request timeout. The spec fixes it at 10 seconds; tests shorten it. */
  timeoutMs: number;
}

export interface ApiFailure {
  ok: false;
  /** HTTP status, or Telegram's `error_code`; null when no answer came back. */
  errorCode: number | null;
  /** Telegram's description, or a plain account of the network failure. */
  description: string;
  /** No answer: network error, reset or timeout. */
  network: boolean;
  /** Seconds Telegram asked us to wait (429). */
  retryAfter?: number;
  /** The group became a supergroup under this ID. */
  migrateToChatId?: number;
}

export type ApiResult<T> = { ok: true; result: T } | ApiFailure;

const BOT_URL_PATTERN = /bot\d+:[\w-]+/g;

/** Removes the token and anything shaped like one from text about to be logged or shown. */
export function redact(text: string, token: string): string {
  let out = text;
  if (token) out = out.split(token).join("[token]");
  return out.replace(BOT_URL_PATTERN, "bot[token]");
}

export async function callApi<T>(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await config.fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    // Error messages from fetch can quote the URL, so describe it by kind only.
    const kind = timeout.aborted ? "timed out" : signal?.aborted ? "was cancelled" : "failed";
    const name = error instanceof Error ? error.name : "Error";
    return {
      ok: false,
      errorCode: null,
      description: `Telegram request ${kind} (${redact(name, config.token)})`,
      network: true,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const data = isRecord(payload) ? payload : {};
  if (response.ok && data.ok === true) {
    return { ok: true, result: data.result as T };
  }

  const parameters = isRecord(data.parameters) ? data.parameters : {};
  const failure: ApiFailure = {
    ok: false,
    errorCode: typeof data.error_code === "number" ? data.error_code : response.status,
    description:
      typeof data.description === "string" && data.description
        ? redact(data.description, config.token)
        : `HTTP ${response.status}`,
    network: false,
  };
  if (typeof parameters.retry_after === "number") failure.retryAfter = parameters.retry_after;
  if (typeof parameters.migrate_to_chat_id === "number") {
    failure.migrateToChatId = parameters.migrate_to_chat_id;
  }
  return failure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the service could not decide: try again later. */
export function isTemporary(failure: ApiFailure): boolean {
  return failure.network || failure.errorCode === 429 || (failure.errorCode ?? 0) >= 500;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
  permissions?: { can_send_messages?: boolean };
}

export interface TelegramChatMember {
  status: string;
  is_member?: boolean;
  can_send_messages?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  my_chat_member?: {
    chat: { id: number; type: string; title?: string };
    new_chat_member: { status: string };
  };
}

export const getMe = (config: TelegramConfig) =>
  callApi<{ id: number }>(config, "getMe", {});

export const getChat = (config: TelegramConfig, chatId: number) =>
  callApi<TelegramChat>(config, "getChat", { chat_id: chatId });

export const getChatMember = (config: TelegramConfig, chatId: number, userId: number) =>
  callApi<TelegramChatMember>(config, "getChatMember", { chat_id: chatId, user_id: userId });

/** One call, no `offset` and no `allowed_updates`: nothing is confirmed and no bot setting changes. */
export const getUpdates = (config: TelegramConfig) =>
  callApi<TelegramUpdate[]>(config, "getUpdates", { timeout: 0 });

export interface SendMessageInput {
  chatId: number;
  html: string;
  silent: boolean;
  button?: { text: string; url: string };
}

export const sendMessage = (config: TelegramConfig, input: SendMessageInput, signal?: AbortSignal) =>
  callApi<unknown>(
    config,
    "sendMessage",
    {
      chat_id: input.chatId,
      text: input.html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(input.silent ? { disable_notification: true } : {}),
      ...(input.button
        ? { reply_markup: { inline_keyboard: [[{ text: input.button.text, url: input.button.url }]] } }
        : {}),
    },
    signal,
  );

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
