# Telegram Notify: technical spec

Status: draft v2, 2026-10-20. Not built yet. One-way only; replaces the
two-way draft (see [History](#history)).

## Goal

Let agents send the user a Telegram message **when they judge it worth it**:
a finished report, a heads-up, a blocker. Each message links back to its bb
thread; the user answers in bb, not in Telegram.

Automatic notifications stay with bb's built-in `push-notifications` plugin
(questions, approvals, errors). This plugin never sends on its own; only the
agent tool sends.

## Why a new plugin

Checked on 2026-10-20 against bb-app 0.46.1, plugin SDK 0.6.49, the plugin
store, and Telegram Bot API 10.3:

| Option | Agent decides what to send | Gap |
| --- | --- | --- |
| Built-in `push-notifications` | No | Only lifecycle events; its RPC has no "send" call |
| [get-bb/bb#5724](https://github.com/get-bb/bb/pull/5724) (open, unreviewed) | Only when the user asked | Not merged; bb app only, not Telegram |
| Telegram Projects (bb-community) | No | Sends every finish/wait/stop |
| Needs You, ntfy (bb-community) | No | Lifecycle events only |
| Hooks (bb-community) + a marker in replies | Yes | Only at end of turn; the marker shows in chat |

The tool is named `telegram_notify`, not `notify_user`, so it can coexist with
#5724.

## Fits the existing homelab pattern

Grafana, Home Assistant and Coolify each have **their own Telegram bot** and
post into two ordinary groups (surveyed by Codex, bb thread `thr_6zuth2ahtc`):

| Service | Home group | Home Admin group |
| --- | --- | --- |
| Grafana | household alerts (contact point `Telegram`) | infrastructure alerts (`Telegram admin`) |
| Home Assistant | household events | scheduled updates |
| Coolify | — | deploys and status |
| **bb (new)** | only when the agent picks it | **default** |

No private bot chats, channels or forum topics are involved, and none of the
existing bots reads messages. bb follows suit: its own bot, the same two
groups, send-only. Its own bot (rather than reusing Home Assistant's) shows
who sent what at a glance and keeps HA's token out of bb.

## User-facing behavior

1. Create a bot with @BotFather (for example "bb") and add it to Home Admin,
   and to Home if wanted.
2. In **Settings → Plugins → Telegram Notify**, paste the bot token and the
   group chat IDs (the same IDs Grafana's contact points use), then
   `bb plugin reload telegram-notify`.
3. An agent calls `telegram_notify`. Home Admin gets:

   ```
   🔔 Nightly backup check done
   PBS verify passed for all 14 guests; B2 sync is 2 days behind.

   homelab · Check PBS and B2 backups
   [Open in bb]
   ```

4. Tapping **Open in bb** opens the thread on `bb.artem.cool`. That works on
   the LAN or over WireGuard; elsewhere the link doesn't load, but the message
   itself is still readable. The user replies in bb.

## Architecture

```
agent ──telegram_notify──▶ plugin (bb server) ──sendMessage──▶ Telegram group
```

Everything runs in the server entry on the bb coordinator (CT133 for
`bb.artem.cool`). No frontend bundle, CLI, background service, webhook, or
public port. Outbound HTTPS to `api.telegram.org` is the only network need.
The bot never calls `getUpdates`, so it can't conflict with anything.

### SDK surfaces used (plugin SDK 0.6.49)

| Need | Surface |
| --- | --- |
| Agent action | `bb.agents.registerTool({ name: "telegram_notify", description, instructions, parameters: zod, execute(args, { threadId, projectId, signal }) })` |
| Offer it only when usable | `bb.agents.configure(ctx => ({ tools: ready && eligible(ctx) ? ["telegram_notify"] : [], skills: [] }))`; `skills` is required |
| Mention Home only when set | `bb.agents.contributeInstructions` |
| Settings | `bb.settings.define({ … })`; every setting needs a `label` |
| Thread facts | `bb.sdk.threads.get`, `bb.sdk.projects.get` |
| Link | `bb.server.experimental_appUrl` + `/projects/<projectId>/threads/<threadId>`, the route Telegram Projects uses |
| Limits | `bb.storage.database()` + `migrate` |
| Bad settings | `bb.status.needsConfiguration(...)`; clears on the next load |

## Settings

All carry a `label`. Changes take effect on `bb plugin reload telegram-notify`.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `botToken` | secret string | — | Stored as a 0600 file, never sent to the frontend or agents |
| `adminChatId` | string | — | Home Admin group; validated as an integer (groups are negative) |
| `homeChatId` | string | empty | Optional Home group; empty = agents can only use Admin |
| `cooldownMinutes` | select `0,1,5,15,60` | `5` | Per thread |
| `hourlyLimit` | number 1–100 | `20` | All threads together |

**Check on load.** The plugin calls `getMe` (token valid) and `getChat` for
each chat ID (bot is a member). Any failure sets `needsConfiguration` with a
plain message: "Bot token rejected", "Bot isn't in the Home Admin group",
and so on. The tool isn't offered until the plugin is ready. A group that
Telegram upgraded to a supergroup returns `migrate_to_chat_id`; the message
then names the new ID to paste in.

## Agent tool

`telegram_notify`

| Parameter | Type | Rule |
| --- | --- | --- |
| `title` | string | 1–80 chars, one line |
| `message` | string | 1–1000 chars |
| `chat` | `"admin"` \| `"home"`, default `"admin"` | `home` fails with `no_home_chat` when `homeChatId` is empty |
| `silent` | boolean, default `false` | Sends with `disable_notification`, for FYI messages |

`execute` uses `ctx.threadId`; the agent can't name another thread.

Results, as tool text:

- `Sent to Home Admin.` / `Sent to Home.`
- error `cooldown`: "Sent one for this thread N minutes ago; try again after
  HH:MM or put it in your reply."
- error `hourly_limit`: the global cap was hit.
- error `rejected <description>`: Telegram refused it; nothing was sent.
- error `uncertain`: the request went out but no answer came back (timeout,
  reset, 5xx). It may have arrived. "Don't retry; mention it in your reply."
  `sendMessage` has no idempotency key, so the plugin never retries either;
  a duplicate is worse than a gap.

**Eligibility** (`configure`): only when the plugin is ready, only for
top-level threads (`parentThreadId === null`; workers report to their parent),
and not in side chats (`origin.pluginId === "side-chat"`). Resolved tools apply
from the thread's next provider session.

**Instructions** (tool snippet):

> Use `telegram_notify` to message the user on their phone when something
> deserves attention away from the screen: a requested report or long task is
> done, you found something they should know soon, or you are blocked on them.
> Don't use it for routine replies, progress updates, or anything the user is
> watching live. One message per task is typical. It posts to the Home Admin
> group by default. Never include secrets, tokens, passwords, or private keys.

When `homeChatId` is set, `contributeInstructions` adds:

> `chat: "home"` posts to the household group, which other people read. Use it
> only for household matters (power, appliances, the house), never for
> infrastructure details.

## Limits

- **Per-thread cooldown** (`cooldownMinutes`, same values as #5724) and a
  **global hourly cap** (`hourlyLimit`), so a runaway agent can't flood the
  groups. Both live in the plugin database and survive reloads.
- Check and reservation are one SQLite transaction: insert the `sends` row,
  then call Telegram, so concurrent calls can't all pass. A `rejected` send
  deletes its row; an `uncertain` one keeps it.
- Sends go through one serial queue. A 429 waits `parameters.retry_after`
  seconds and retries that call (a 429 is a definite "not sent"), up to the
  tool call's `signal`.

## Message format

`parse_mode: "HTML"`. The plugin owns the markup; every agent- or
thread-supplied field is truncated first, then escaped (`&`, `<`, `>`), so an
entity is never split:

```
🔔 <b>{title}</b>
{message}

<i>{project name} · {thread title}</i>
```

Project and thread names are cut to 64 characters, so a message stays under
~1250 characters, well inside Telegram's 4096. An inline keyboard button
**Open in bb** → `{appUrl}/projects/{projectId}/threads/{threadId}`; if
`appUrl` is null the button is left out. `link_preview_options:
{ is_disabled: true }`, so Telegram never tries to fetch the LAN-only URL.

## Storage

One table; message text isn't stored.

```sql
CREATE TABLE sends (                -- cooldown and hourly cap
  thread_id TEXT NOT NULL,
  chat TEXT NOT NULL,               -- 'admin' | 'home'
  at INTEGER NOT NULL
);
CREATE INDEX sends_thread_at ON sends (thread_id, at);
```

Rows older than a day are deleted on each send.

## Security

- **Send-only.** The bot reads nothing, so Telegram can't be used to steer
  agents. A leaked token lets someone post as the bot, and read nothing the
  bot hasn't sent.
- The token never appears in logs, tool results or errors. Bot API errors are
  logged without the request URL, which contains the token.
- Outbound text leaves the homelab for Telegram's servers and is readable by
  every member of the target group. The instructions forbid secrets and keep
  infrastructure out of Home; the plugin doesn't try to detect secrets.
- The link exposes the `bb.artem.cool` hostname and thread IDs to Telegram.
  bb is LAN/WireGuard-only, so the URL alone gives no access.

## Testing

`@get-bb/plugin-sdk/testing` (`createFakePluginHost`) with an injected
`fetch` for the Bot API; `threads.get` and `projects.get` stubbed explicitly.

- Load check: good settings; bad token; bot not in a group; supergroup
  migration message; missing Admin ID.
- Tool: offered only when ready and top-level; validation; `chat: "home"`
  with and without `homeChatId`; cooldown and hourly cap under concurrent
  calls; `rejected` vs `uncertain`; 429 retry; HTML escaping of hostile
  titles; length budget with long names; no button without `appUrl`.

Live, on `bb.artem.cool`: one message to Home Admin from a thread, tap the
link on the phone (on WireGuard), check the cooldown message.

## Rollout

1. Build in `plugins/telegram-notify` of this repo; release
   `telegram-notify/v0.1.0`; add the marketplace entry.
2. Check CT133 can reach `api.telegram.org:443` (UniFi IPS has blocked worker
   traffic before; see the homelab UniFi notes).
3. User creates the bot and adds it to Home Admin (and Home if wanted).
4. Copy the chat IDs from Grafana's `Telegram admin` / `Telegram` contact
   points into the settings; the user pastes the token. Chat IDs and the
   token stay out of Git.
5. Install on `bb.artem.cool`, reload, live-test. Record it in homelab
   `applications/bb/README.md` next to the other Telegram senders.
6. Optionally set `push-notifications` `defaultLevel` to `input-only`, so
   finished turns stop pushing and Telegram carries the reports.

## Out of scope

- Replies from Telegram, and anything else that reads updates.
- A CLI or automations sending through the plugin.
- More than two named chats, private chats, and forum topics.
- Child threads using the tool.

## History

- **v1 (two-way)**: replies in Telegram forwarded into the thread and the
  answer sent back. Codex reviewed it (bb thread `thr_4k7u6j474q`) and found
  15 issues, both high-severity ones in reply handling: possible duplicate
  delivery of a command to an agent with sudo, and answers forwarded to the
  wrong reply. That version is in Git history at `a6ddd7a`.
- **v2 (this)**: the user chose one-way. Review findings that still apply are
  kept: complete SDK examples, `rejected` vs `uncertain` sends, atomic limits
  and 429 handling, `needsConfiguration` instead of a "degraded" status, and
  the length budget.
