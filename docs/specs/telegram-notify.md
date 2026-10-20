# Telegram Notify: technical spec

Status: draft, 2026-10-20, revised after a Codex review (15 findings, all
accepted; see [Review log](#review-log)). Not built yet.

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
                        bb.sdk.threads.send(mode: "queue-if-active")
```

Everything runs in the server entry on the bb coordinator (CT133 for
`bb.artem.cool`). No frontend bundle, host entry, webhook, or public port.
Outbound HTTPS to `api.telegram.org` is the only network need.

### SDK surfaces used (plugin SDK 0.6.49)

| Need | Surface |
| --- | --- |
| Agent action | `bb.agents.registerTool({ name: "telegram_notify", description, instructions, parameters: zod, execute(args, { threadId, projectId, signal }) })` (`description` is required) |
| Offer it only when usable | `bb.agents.configure(ctx => ({ tools: paired && eligible(ctx) ? ["telegram_notify"] : [], skills: [] }))`; `skills` is required, and a missing array fails closed |
| When to use it | Tool `instructions` (≤4096 chars) |
| Settings | `bb.settings.define({ botToken: { type: "string", label: "Bot token", secret: true }, … })`; every setting needs a `label` |
| Receive replies | `bb.background.service("poller", { start(signal) })` |
| Deliver a reply | `bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] })` → `{ delivery: "sent" }` or `{ delivery: "queued", queuedMessage }` |
| Follow a queued reply | `bb.events.on("message.dispatched" \| "message.cancelled", ({ entry }))`, `bb.sdk.threads.queuedMessages.list` |
| Agent's answer | `bb.events.on("thread.idle", ({ thread, lastAssistantText }))` (text may be `null`), `thread.failed`; `bb.sdk.threads.output` when reconciling |
| Thread facts | `bb.sdk.threads.get`, `bb.sdk.projects.get` |
| Link | `bb.server.experimental_appUrl` + `/projects/<projectId>/threads/<threadId>`, the route Telegram Projects uses |
| State | `bb.storage.database()` + `migrate`, all of it, so routing state and the offset change in one transaction |
| CLI | `bb.cli.register(defineCli({ name: "telegram-notify", … }))` |
| Missing or bad token | `bb.status.needsConfiguration(...)`; it clears on the next load, so the fix is `bb plugin reload telegram-notify` |

Event handlers run concurrently and fire-and-forget; events missed while the
plugin is reloading are not replayed. Every handler below is written to be
safe under both: state changes are conditional SQL updates, and the poller
reconciles open exchanges at start.

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
- error `not_paired` / `rejected <description>`: Telegram refused it (4xx
  other than 429) or the bot isn't paired; nothing was sent.
- error `uncertain`: the request went out but no answer came back (timeout,
  reset, 5xx). Telegram may have delivered it. "Don't retry; mention it in
  your reply instead." `sendMessage` has no idempotency key, so the plugin
  never retries automatically either; a duplicate is worse than a gap.

**Eligibility** (`configure`): the tool is offered only when a bot token and a
paired chat exist, and only to threads with `parentThreadId === null`. Child
workers report to their parent; that parent can notify. Side chats
(`origin.pluginId === "side-chat"`) are excluded.
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
- Both live in the plugin database, so they survive reloads.
- The check and the reservation are one SQLite transaction: insert the
  `sends` row, then call Telegram. Concurrent calls can't all pass. A
  `rejected` send deletes its row; an `uncertain` one keeps it.
- All outbound Bot API calls (notifications, receipts, answers) go through one
  serial queue. A 429 pauses the queue for `retry_after` seconds and then
  retries that call: a 429 is a definite "not sent".

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

The whole rendered text must fit Telegram's 4096-character limit (after
entities parsing). Project and thread names are cut to 64 characters each,
and every field is truncated *before* escaping so an `&amp;` is never split.
With the tool's caps a notification is at most ~1250 characters. Answers use
the same HTML mode and the same escaping, and are truncated (below).

## Replies

### Inbound: Telegram → thread

The poller calls `getUpdates` with `timeout: 50`,
`allowed_updates: ["message"]` and the stored `offset`.

For each update, in order:

1. **Claim it.** In one transaction: `INSERT INTO inbound_updates (update_id,
   state='claimed')` and advance `offset` past it. If the row already exists,
   skip the update. From here the update is never replayed, even after a
   crash.
2. Drop silently unless `message.chat.type === "private"`. Strangers learn
   nothing.
3. `/start <code>` → pairing (below). This runs **before** the owner check,
   because the first pairing has no owner yet.
4. Drop silently unless `chat.id === owner.chatId` and
   `from.id === owner.userId`.
5. `repliesEnabled` off → "Replies are off." Other `/` commands → help text.
6. Not a reply, or replying to a message not in `sent_messages` for the
   current pairing generation → hint.
7. Look up the thread. If it's archived or deleted → "That thread is
   archived; open bb to continue." and stop.
8. Insert an `exchanges` row (`state='submitting'`, current generation,
   `submitted_at`), mark the update `submitting`, then call
   `threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text",
   text: "[Telegram] " + text, mentions: [] }] })`.
9. On the result, mark the update `submitted` and the exchange `running`
   (`sent`) or `queued` with `queuedMessage.id` (`queued`). On an error, mark
   both `failed`.
10. Queue a receipt through the outbound queue. A failed receipt is logged and
    never causes a resend.

Receipts, from the send result:

| Result | Receipt |
| --- | --- |
| `sent` | "→ sent" |
| `queued`, `waitingOn.kind` `thread-busy` / `turn-starting` | "→ queued behind the current turn" |
| `interaction` | "→ queued: the thread is waiting on a question in bb" |
| `host-offline` / `provisioning` / `stopping` | "→ queued: the machine isn't ready ({hostName})" |
| `plugin` / `time` | "→ queued: {reason}" |
| error | "→ not delivered: {short error}; open bb" |

**Uncertain submissions.** If the plugin restarts and finds an update still
in `submitting`, it doesn't know whether bb took the message. It doesn't
resend (that could repeat a sudo command). It marks the update `uncertain`
and sends "Not sure your reply \"{first 40 chars}…\" reached the thread;
check bb before resending."

Text only in v1: stickers, photos and voice get "Text replies only for now."
Text over 4000 characters is refused, not truncated.

### Outbound answer: thread → Telegram

The plugin tracks each Telegram reply as an **exchange**:
`submitting → queued → running → answered`, or `cancelled`, `failed`,
`expired`, `revoked`. A thread can have several open exchanges (the user
replied twice); bb runs them in its queue order.

- `message.dispatched` with an `entry.id` matching a `queued` exchange →
  `running`. `message.cancelled` → `cancelled`, with the reply "Your message
  was removed from the queue in bb."
- `thread.idle` → in one statement, claim every `running` exchange for that
  thread whose `submitted_at` is earlier than `thread.updatedAt`:
  `UPDATE … SET state='answered' WHERE state='running' AND … RETURNING`. Only
  the handler that wins the update delivers, so an answer is never sent
  twice. A `queued` exchange is untouched: the idle answer belongs to the
  turn ahead of it, not to the user's reply.
- If bb ran several claimed exchanges in one turn, the answer goes once, as a
  reply to the newest Telegram message.
- The answer is `lastAssistantText`. Fenced ```` ```ui ```` and ```` ```app ````
  blocks become `[interactive card, open in bb]`. `null` or empty becomes
  "(Finished without a text reply; open bb.)" Truncate to fit 4096 with
  "… full reply in bb", escape, and send it as
  `reply_parameters: { message_id: <user's message> }` with the Open button.
  Record it in `sent_messages` so replying again continues.
- `thread.failed` → claim the same way, send "The thread stopped with an
  error; open bb."
- Exchanges open for 6 hours become `expired` silently, so tomorrow's
  unrelated turn isn't forwarded.

**Reconcile on start.** Events during a reload are lost, so when the poller
starts, it walks open exchanges:

- `queued`: if `queuedMessages.list` no longer has the row, treat it as
  dispatched (`running`).
- `running`: if `threads.get` says the thread is idle and
  `updatedAt > submitted_at`, claim and deliver `threads.output`.
- `submitting`: mark `uncertain` as above.

Only turns started by a Telegram reply are forwarded. Normal turns stay in bb.

## Pairing and owner identity

- `bb telegram-notify pair` creates a 16-byte random code (base64url, ≤64
  chars as `/start` allows), stores its SHA-256 and a 10-minute expiry in `state`,
  and prints the `t.me/<bot username>?start=<code>` link. The username comes
  from `getMe`.
- The first private-chat `/start <code>` that matches stores
  `owner = { chatId, userId, username, pairedAt }`, deletes the code (single
  use), and bumps the **generation**. Wrong or expired codes are ignored
  silently.
- Every `sent_messages` and `exchanges` row carries the generation it was
  made under. Lookups and deliveries filter on the current one, and inbound
  step 8 and answer delivery re-read it right before acting.
- **Revocation** (re-pair, `unpair`, or a `botToken` change seen on reload)
  bumps the generation in one transaction that also deletes any pairing code
  and marks open exchanges `revoked`. Nothing is delivered for them. A tool
  call already past its reservation checks the generation again just before
  `sendMessage`. A token change also resets the offset, since update and
  message ids belong to a bot.
- `unpair` removes the tool from future sessions; sessions already running
  keep the tool until their next session, but its calls fail `not_paired`.

## Poller details

- One `getUpdates` consumer per bot token. A 409 means a webhook is set or
  another long poll replaced ours; the two have different descriptions, and
  the plugin records which. It's a diagnostic, not a guarantee: a short
  poller elsewhere can take updates without causing one. On 409 the plugin
  backs off to 5 minutes and does **not** call `deleteWebhook`, so it never
  silently breaks another consumer. Use a separate bot per bb server
  (`bb.artem.cool`, `bb-work`) and never the Telegram Projects bot.
- The SDK has no "degraded" status. Poller health (last success, last error,
  409 kind, backoff) shows in `bb telegram-notify status` and the plugin log.
  Only a missing token or a 401 sets `needsConfiguration`, which a reload
  clears.
- 429 → wait `parameters.retry_after` seconds. Network errors → capped
  exponential backoff (1 s → 60 s).
- The service resolves when `signal` aborts; the in-flight request is aborted
  with it.
- Updates are kept by Telegram for 24 hours, so a coordinator down longer
  than that loses replies. Acceptable.

## Storage

One SQLite database (`bb.storage.database()`, append-only `migrate`). Message
text isn't stored; only ids, states and times.

```sql
CREATE TABLE state (                -- one row each: owner, pairing, offset, generation, bot_id
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL               -- JSON
);
CREATE TABLE sent_messages (
  message_id INTEGER NOT NULL,      -- Telegram message id in the owner chat
  generation INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'notify' | 'answer'
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (generation, message_id)
);
CREATE TABLE inbound_updates (
  update_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,              -- claimed | submitting | submitted | uncertain | failed | ignored
  at INTEGER NOT NULL
);
CREATE TABLE exchanges (
  id INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  user_message_id INTEGER NOT NULL, -- the Telegram message to reply to
  queued_message_id TEXT,           -- bb queued row, when queued
  state TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX exchanges_open ON exchanges (thread_id, state);
CREATE TABLE sends (                -- cooldown and hourly cap
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
```

A daily `bb.background.schedule` deletes `sent_messages` older than 30 days,
`inbound_updates` older than 2 days, closed exchanges older than 2 days, and
expires open ones past 6 hours. Replying to a notification older than 30 days
gets the "not a notification" hint.

## Settings

All settings carry a `label`. Changing `botToken` takes effect on
`bb plugin reload telegram-notify`.

| Key | Type | Default |
| --- | --- | --- |
| `botToken` | secret string | — |
| `cooldownMinutes` | select `0,1,5,15,60` | `5` |
| `hourlyLimit` | number 1–100 | `20` |
| `repliesEnabled` | boolean | `true`; off = outbound only, inbound gets "Replies are off." |

## CLI

```
bb telegram-notify status [--json]      token set, bot username, paired chat, poller state, last error, sends this hour
bb telegram-notify pair                 print a pairing link (10 min)
bb telegram-notify unpair
bb telegram-notify send --title <t> (--message <m> | --message-stdin) [--thread <id>] [--silent] [--json]
```

`send` uses the invoking thread when `--thread` is omitted, with the same
limits as the tool, so scripts and automations can notify too. It doubles as
the setup test. bb's plugin CLI accepts exactly one non-empty stdin line
(≤16 KiB) for `--message-stdin`, so `send` turns a literal `\n` into a
newline for multi-line messages.

## Security

This plugin turns a Telegram account into a way to give orders to bb agents.
On `bb.artem.cool` those agents have guest sudo on CT125/CT135 and homelab
credentials, and bb's own API is unauthenticated on the LAN. Telegram adds a
route **from the internet**, so:

- Inbound accepts only the paired user in the paired private chat. Group
  chats, channels and other users are dropped without reply.
- Inbound can only reach threads the plugin notified about, under the
  current pairing. It can't create threads, run commands, approve
  permissions, or answer bb questions in v1.
- No Telegram message is ever submitted to bb twice. An update is claimed
  before submission, and an unclear outcome is reported, not retried.
- Answers go only to the exchange that asked, and never after revocation.
- `repliesEnabled = false` gives a send-only bot.
- Whoever holds the bot token can send as the bot and consume its updates
  (maybe without the poller noticing), but can't send messages as the owner,
  so they can't pass the owner check (Telegram sets `from.id`). Anyone who gets into the user's Telegram account can steer
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
`fetch` for the Bot API. The fake host doesn't implement thread delivery, so
`threads.send`, `threads.get`, `threads.output` and `queuedMessages.list` are
stubbed explicitly. Its events arrive one at a time, so the race tests call
the store functions directly with interleaved steps.

- Tool: offered only when paired and top-level; validation; cooldown and
  hourly cap under concurrent calls; `rejected` vs `uncertain`; HTML escaping
  of hostile titles; length budget with long project and thread names.
- Pairing: first pairing with no owner; wrong, expired, reused code;
  revocation drops open exchanges and old reply targets.
- Inbound: owner gate (other user, group chat), repeated `update_id`,
  unknown reply target, archived thread, each receipt kind, a receipt that
  fails without resubmitting, a crash between claim and submit (→ uncertain).
- Answer: forwarded once after a Telegram reply, not after normal turns; a
  queued reply isn't answered by the turn ahead of it; two replies batched
  into one turn; two handlers racing on one idle; `null` text; ui-block
  stripping; truncation; expiry; failure notice; cancelled queued row.
- Reconcile: reload while queued, while running, and after the thread went
  idle.
- Poller: both 409 kinds back off without `deleteWebhook`, 429 honors
  `retry_after`, abort ends the service.

Live, on `bb.artem.cool` with a test bot: pair, notify from a thread, reply
while it's idle and while it's running, reply twice quickly, reply to the
answer, reload the plugin mid-turn.

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
- Child threads using the tool (no setting; revisit if needed).
- Summarized answers.

## Decisions

The three open questions from the first draft, settled with the review:

1. **Busy thread → `queue-if-active`**, not `auto`. `auto` joins the running
   turn and can redirect work in progress. Queuing keeps the turn intact, and
   the exchange states above make queued replies get the right answer.
2. **Child threads excluded**, with no setting in v0.1. The parent owns
   notifications and follow-up.
3. **Forward the real answer, truncated.** A generated summary adds cost,
   latency and another failure path, and can drop the agent's caveats or its
   question.

## Review log

Codex (bb thread `thr_4k7u6j474q`, 2026-10-20) checked the first draft
against `get-bb/bb` `desktop-v0.46.1` and the Bot API. Accepted and folded in
above:

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High | A crash or failed receipt could resubmit a reply | Claim the update before submitting; uncertain → report, never replay |
| 2 | High | Thread-level pending row could forward an unrelated answer | Exchange states, queued-row tracking, atomic claim |
| 3 | Medium | Revocation left codes and in-flight work live | Pairing generation on every row, rechecked before acting |
| 4 | Medium | Owner gate ran before `/start`, so first pairing failed | `/start` before the owner check |
| 5 | Medium | Incomplete SDK examples (`skills`, `label`, `description`) | Completed |
| 6 | Medium | `input` was a string; `queued` isn't only "waiting on a question" | Prompt-block array; receipts from `waitingOn` |
| 7 | Medium | Events lost during reload | Reconcile open exchanges at start |
| 8 | Medium | Network failure ≠ not sent | `rejected` vs `uncertain`, no auto-retry |
| 9 | Medium | Limits raced; receipts and answers ignored 429 | Atomic reservation, one serial outbound queue |
| 10 | Medium | No public "degraded" status | Health in CLI and log; `needsConfiguration` only for token problems |
| 11 | Medium | 409 overstated as compromise detection | Reworded as a diagnostic |
| 12 | Medium | Length budget missed names; `null` text; parse mode unclear | Name caps, truncate before escape, HTML throughout, empty fallback |
| 13 | Low | Fake host lacks thread delivery and concurrency | Explicit stubs, direct race tests |
| 14 | Low | `--message-stdin` takes one line | Documented; `\n` escapes |
| 15 | Low | kv + SQLite split prevents one transaction; v0.1 too big | Everything in SQLite; dropped `childThreads` and `test` |
