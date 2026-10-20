# Telegram Notify: technical spec

Status: draft, 2026-10-20. Not built yet.

## Goal

Let agents send the user a Telegram message **when they judge it worth it**:
a finished report, a heads-up, a blocker. Let the user answer by replying to
that message in Telegram; the reply goes to the same bb thread, and the agent's
next answer comes back to Telegram.

Automatic notifications stay with bb's built-in `push-notifications` plugin
(questions, approvals, errors). This plugin never sends on lifecycle events by
itself, except the one answer to a Telegram reply (see [Replies](#replies)).

## Why a new plugin

Checked on 2026-10-20 against bb-app 0.46.1, plugin SDK 0.6.49, the plugin
store, and Telegram Bot API 10.3:

| Option | Agent decides what to send | Two-way | Gap |
| --- | --- | --- | --- |
| Built-in `push-notifications` | No | In the bb app | Only lifecycle events; its RPC has no "send" call |
| [get-bb/bb#5724](https://github.com/get-bb/bb/pull/5724) (open, unreviewed) | Yes, only when the user asked | In the bb app | Not merged; its tool instructions forbid unprompted sends |
| Telegram Projects (bb-community) | No | Yes | Sends every finish/wait/stop; no command or tool to send |
| Needs You, ntfy (bb-community) | No | No | Lifecycle events only |
| Hooks (bb-community) + a marker in replies | Yes | No | Only at end of turn; marker shows in chat |

If #5724 merges, it covers the bb-app half of this. This plugin is still the
Telegram half, and its tool name avoids `notify_user` so both can coexist.

## User-facing behavior

1. The user creates a bot with @BotFather and saves its token in
   **Settings → Plugins → Telegram Notify**.
2. `bb telegram-notify pair` prints a `https://t.me/<bot>?start=<code>` link.
   Opening it and pressing **Start** pairs the user's private chat. Until then,
   agents don't see the tool.
3. An agent calls `telegram_notify` with a short message. The user gets:

   ```
   🔔 Nightly backup check done
   PBS verify passed for all 14 guests; B2 sync is 2 days behind.

   homelab · Check PBS and B2 backups
   [Open in bb]
   ```

4. The user swipes to reply in Telegram: "kick off the B2 sync". The text goes
   into that thread as a user message. When the agent's turn ends, its reply is
   sent back as a Telegram reply to the user's message. Replying to *that*
   continues the conversation.
5. A message that isn't a reply gets a one-line hint: "Reply to a notification
   to answer its thread."

## Architecture

```
agent ──telegram_notify──▶ plugin (bb server) ──sendMessage──▶ Telegram
                                  ▲                               │
   thread.idle ──echo answer──────┤                               │
                                  └──getUpdates long poll◀────────┘
                                         │ reply_to_message → threadId
                                         ▼
                             bb.sdk.threads.send(mode: "auto")
```

Everything runs in the server entry on the bb coordinator (CT133 for
`bb.artem.cool`). No frontend bundle, host entry, webhook, or public port.
Outbound HTTPS to `api.telegram.org` is the only network need.

### SDK surfaces used (plugin SDK 0.6.49)

| Need | Surface |
| --- | --- |
| Agent action | `bb.agents.registerTool({ name: "telegram_notify", parameters: zod, execute(args, { threadId, projectId, signal }) })` |
| Offer it only when usable | `bb.agents.configure(ctx => ({ tools: paired && eligible(ctx) ? ["telegram_notify"] : [] }))` |
| When to use it | Tool `instructions` (≤4096 chars) plus `skills/telegram-notify/SKILL.md` |
| Bot token | `bb.settings.define({ botToken: { type: "string", secret: true } })` |
| Receive replies | `bb.background.service("poller", { start(signal) })` |
| Deliver a reply | `bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] })` |
| Agent's answer | `bb.events.on("thread.idle", ({ thread, lastAssistantText }))`, `thread.failed` |
| Thread facts | `bb.sdk.threads.get`, `bb.sdk.projects.get` |
| Link | `bb.server.experimental_appUrl` + `/projects/<projectId>/threads/<threadId>`, the route Telegram Projects uses |
| State | `bb.storage.kv` (small), `bb.storage.database()` + `migrate` (mappings) |
| CLI | `bb.cli.register(defineCli({ name: "telegram-notify", … }))` |
| Not configured | `bb.status.needsConfiguration(...)` |

## Agent tool

`telegram_notify`

| Parameter | Type | Rule |
| --- | --- | --- |
| `title` | string | 1–80 chars, one line |
| `message` | string | 1–1000 chars |
| `silent` | boolean, default `false` | Sends with `disable_notification`, for FYI messages |

`execute` uses `ctx.threadId`; the agent can't name another thread.

Results, as tool text:

- `Sent to Telegram.`
- error `cooldown`: "Sent one for this thread N minutes ago; try again after HH:MM or put it in your reply."
- error `hourly_limit`: the global cap was hit.
- error `not_paired` / `bot_error <description>`: delivery failed; nothing was sent.

**Eligibility** (`configure`): the tool is offered only when a bot token and a
paired chat exist, and to threads with `parentThreadId === null` unless the
setting `childThreads` is on. Child workers report to their parent; that
parent can notify. Side chats (`origin.pluginId === "side-chat"`) are excluded.
Resolved tools apply to the next provider session, so pairing reaches running
threads on their next session, not mid-turn.

**Instructions** (tool snippet, short):

> Use `telegram_notify` to message the user on their phone when something
> deserves attention away from the screen: a requested report or long task is
> done, you found something they should know soon, or you are blocked on them.
> Don't use it for routine replies, progress updates, or anything the user is
> watching live. One message per task is typical. Never include secrets,
> tokens, passwords, or private keys; Telegram is not end-to-end encrypted for
> bots. If the user's message starts with `[Telegram]`, they are on their phone:
> keep the answer short, and your reply is forwarded to them automatically, so
> don't also call `telegram_notify` for it.

## Limits

- **Per-thread cooldown**: `cooldownMinutes` setting, `0|1|5|15|60`, default
  `5` (same values as #5724). Replies forwarded back to Telegram don't count.
- **Global cap**: `hourlyLimit` setting, default `20` tool sends per rolling
  hour across all threads. A runaway agent can't flood the chat.
- Both live in the plugin database, so they survive reloads. A failed
  delivery doesn't consume the cooldown.

## Message format

`parse_mode: "HTML"`. All agent- and thread-supplied text is escaped
(`&`, `<`, `>`). The plugin owns the markup:

```
🔔 <b>{title}</b>
{message}

<i>{project name} · {thread title}</i>
```

with an inline keyboard button **Open in bb** →
`{appUrl}/projects/{projectId}/threads/{threadId}`. If `appUrl` is null the
button is omitted. `link_preview_options: { is_disabled: true }`.

The whole text must fit Telegram's 4096-character limit (after entities
parsing). The tool's input caps make that true for notifications; answers are
truncated (below).

## Replies

### Inbound: Telegram → thread

The poller calls `getUpdates` with `timeout: 50`,
`allowed_updates: ["message"]` and the stored `offset`.

For each update, in order:

1. Skip if `update_id` is already in `inbound_updates` (dedupe across crashes).
2. Drop silently unless `message.chat.type === "private"`,
   `chat.id === owner.chatId` and `from.id === owner.userId`. No reply, so a
   stranger learns nothing.
3. `/start <code>` → pairing (below). Other `/` commands → help text.
4. Not a reply, or replying to a message not in `sent_messages` → hint.
5. Look up the thread. If it's archived, deleted, or hidden → "That thread is
   archived; open bb to continue." and stop.
6. `threads.send({ threadId, mode: "auto", input: "[Telegram] " + text })`.
   `auto` steers a live turn and starts one on an idle thread, so the reply
   reaches the agent at once.
7. Reply with a short receipt: "→ sent" or, when `delivery` is
   `queued` (the thread waits on a question or approval), "→ queued: the thread
   is waiting on a question in bb." Then record `pending_answers` for the thread.
8. Record the `update_id` with its outcome, then advance the stored offset past it.

Text only in v1: stickers, photos and voice get "Text replies only for now."
Text over 4000 characters is refused, not truncated.

### Outbound answer: thread → Telegram

On `thread.idle` for a thread with an unexpired `pending_answers` row:

- Take `lastAssistantText`. Replace fenced ```` ```ui ```` and ```` ```app ````
  blocks with `[interactive card, open in bb]`, since genui cards are
  unreadable as text. Send it as plain text (escaped), truncated to fit 4096
  with "… full reply in bb" and the Open button.
- Send as `reply_parameters: { message_id: <user's message> }`; record the new
  message in `sent_messages` so replying again continues.
- Delete the pending row.

On `thread.failed`: send "The thread stopped with an error; open bb." and
delete the row. Rows expire after 6 hours, so an answer from tomorrow's
unrelated turn isn't forwarded.

Only turns started or steered by a Telegram reply are forwarded. Normal
turns stay in bb.

## Pairing and owner identity

- `bb telegram-notify pair` creates a 16-byte random code (base64url, ≤64
  chars as `/start` allows), stores its SHA-256 and a 10-minute expiry in kv,
  and prints the `t.me/<bot username>?start=<code>` link. The username comes
  from `getMe`.
- The first private-chat `/start <code>` that matches stores
  `owner = { chatId, userId, username, pairedAt }` and deletes the code.
  Wrong or expired codes are ignored silently.
- Pairing again replaces the owner and clears `sent_messages` and
  `pending_answers`, since message ids are per chat. `bb telegram-notify
  unpair` clears the owner, which removes the tool from future sessions.
- Changing `botToken` clears the owner, offset and mappings, because message
  ids belong to a bot.

## Poller details

- One `getUpdates` consumer per bot token. Telegram answers a second consumer
  or a set webhook with HTTP 409. On 409 the plugin reports a degraded status
  ("another bot client is using this token"), backs off to 5 minutes, and does
  **not** call `deleteWebhook`: it shouldn't break another consumer silently.
  Use a separate bot per bb server (`bb.artem.cool`, `bb-work`) and never the
  Telegram Projects bot.
- 429 → wait `parameters.retry_after` seconds. Network errors → capped
  exponential backoff (1 s → 60 s). 401 → `needs-configuration` (bad token).
- The service resolves when `signal` aborts; the in-flight request is aborted
  with it.
- Updates are kept by Telegram for 24 hours, so a coordinator down longer
  than that loses replies. Acceptable.

## Storage

kv:

| Key | Value |
| --- | --- |
| `owner` | `{ chatId, userId, username, pairedAt }` |
| `pairing` | `{ codeSha256, expiresAt }` |
| `offset` | next `getUpdates` offset |

SQLite (`migrate`, append-only):

```sql
CREATE TABLE sent_messages (
  message_id INTEGER PRIMARY KEY,   -- Telegram message id in the owner chat
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'notify' | 'answer'
  sent_at INTEGER NOT NULL
);
CREATE TABLE inbound_updates (
  update_id INTEGER PRIMARY KEY,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE pending_answers (
  thread_id TEXT PRIMARY KEY,
  reply_to_message_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE sends (                -- cooldown and hourly cap
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
```

A daily `bb.background.schedule` deletes `sent_messages` older than 30 days,
`inbound_updates` older than 2 days and expired `pending_answers`. Replying
to a notification older than 30 days gets the "not a notification" hint.

Message text isn't stored; only ids and times.

## Settings

| Key | Type | Default |
| --- | --- | --- |
| `botToken` | secret string | — |
| `cooldownMinutes` | select `0,1,5,15,60` | `5` |
| `hourlyLimit` | number 1–100 | `20` |
| `childThreads` | boolean | `false` |
| `repliesEnabled` | boolean | `true`; off = outbound only, inbound gets "Replies are off." |

## CLI

```
bb telegram-notify status [--json]      token set, bot username, paired chat, poller state, last error, sends this hour
bb telegram-notify pair                 print a pairing link (10 min)
bb telegram-notify unpair
bb telegram-notify send --title <t> (--message <m> | --message-stdin) [--thread <id>] [--silent] [--json]
bb telegram-notify test                 send a labeled test message
```

`send` uses the invoking thread when `--thread` is omitted, with the same
limits as the tool, so scripts and automations can notify too.

## Security

This plugin turns a Telegram account into a way to give orders to bb agents.
On `bb.artem.cool` those agents have guest sudo on CT125/CT135 and homelab
credentials, and bb's own API is unauthenticated on the LAN. Telegram adds a
route **from the internet**, so:

- Inbound accepts only the paired user in the paired private chat. Group
  chats, channels and other users are dropped without reply.
- Inbound can only reach threads the plugin notified about. It can't create
  threads, run commands, approve permissions, or answer bb questions in v1.
- `repliesEnabled = false` gives a send-only bot.
- Whoever holds the bot token can send as the bot and consume its updates
  (the poller then sees 409), but can't send messages as the owner, so they
  can't pass the owner check (Telegram sets `from.id`). Anyone who gets into the user's Telegram account can steer
  agents; the user should have Telegram two-step verification on.
- The token is a secret setting (0600 file on the coordinator, never sent to
  the frontend or agents). It never appears in logs or CLI output; error
  messages from the Bot API are logged without the request URL, which
  contains the token.
- Outbound text leaves the homelab for Telegram's servers. The instructions
  forbid secrets; the plugin doesn't try to detect them.
- Prefix `[Telegram]` tells the agent where the text came from. It isn't a
  security boundary: the agent treats it as the user's message.

## Testing

`@get-bb/plugin-sdk/testing` (`createFakePluginHost`) with an injected
`fetch` standing in for the Bot API (the only mock):

- Tool: offered only when paired and eligible; validation; cooldown and
  hourly cap; HTML escaping of hostile titles; length limits.
- Pairing: valid, wrong, expired code; token change clears state.
- Inbound: owner gate (other user, group chat), dedupe on repeated
  `update_id`, unknown reply target, archived thread, `sent` vs `queued`
  receipt, offset advances only after recording.
- Answer: forwarded once after a Telegram reply, not after normal turns,
  ui-block stripping, truncation, expiry, failure notice.
- Poller: 409 degrades without `deleteWebhook`, 429 honors `retry_after`,
  abort ends the service.

Live, on `bb.artem.cool` with a test bot: pair, notify from a thread, reply
while it's idle and while it's running, reply to the answer, reload the
plugin mid-poll.

## Rollout

1. Build in `plugins/telegram-notify` of this repo; release
   `telegram-notify/v0.1.0`; add the marketplace entry.
2. Check CT133 can reach `api.telegram.org:443` (UniFi IPS has blocked worker
   traffic before; see the homelab UniFi notes).
3. Install on `bb.artem.cool`, pair, live-test. Record it in homelab
   `applications/bb/README.md`.
4. Optionally set `push-notifications` `defaultLevel` to `input-only`, so
   finished turns stop pushing and Telegram carries the reports.
5. `bb-work` later, with its own bot, if wanted.

## Out of scope for v1

- Voice replies (`getFile` ≤20 MB + `bb.sdk.system.transcribeVoice`).
- Answering bb questions and approvals from Telegram (buttons).
- Starting new threads from Telegram.
- Routing a non-reply message to "the last notified thread".

## Open questions

1. Is `auto` right for a reply to a busy thread, or should it queue
   (`queue-if-active`) so it doesn't redirect the running turn?
2. Should child threads be eligible by default?
3. Should the answer forward the whole reply (truncated) or a summary?
