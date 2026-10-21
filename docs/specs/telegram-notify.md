# Telegram Notify: technical spec

Status: v2.4, built and shipped as `telegram-notify` 0.1.1 on 2026-10-21;
installed on `bb.artem.cool` and `bb-work.artem.cool` and live-tested. One-way
only; chats are managed in the plugin's own settings section (see
[History](#history) for where the build differs from this spec).

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
existing bots reads messages. bb follows suit: its own bot, ordinary groups,
send-only. Its own bot (rather than reusing Home Assistant's) shows who sent
what at a glance and keeps HA's token out of bb. Home Admin and Home are the
first two chats; more can be added later (for example a group per project)
without a code change.

## User-facing behavior

1. Create a bot with @BotFather (for example "bb") and add it to Home Admin,
   and to Home if wanted.
2. In **Settings → Plugins → Telegram Notify**, paste the bot token, then
   `bb plugin reload telegram-notify`.
3. Below the token, the plugin's **Chats** section lists where agents may
   post:

   | Name | When to use | Status |
   | --- | --- | --- |
   | Home Admin (default) | infrastructure, reports, blockers | ✓ ready |
   | Home | household matters only | ✓ ready |

   **Find groups** lists the groups the bot was added to in the last 24 hours;
   picking one fills in its ID and title. **Add** takes a chat ID by hand (the
   same IDs Grafana's contact points use). Each row has a name, a "when to
   use" note for the agent, and a live check. Rows can be reordered; the first is the default. Saving
   needs no reload.
4. An agent calls `telegram_notify`. Home Admin gets:

   ```
   🔔 Nightly backup check done
   PBS verify passed for all 14 guests; B2 sync is 2 days behind.

   homelab · Check PBS and B2 backups
   [Open in bb]
   ```

5. Tapping **Open in bb** opens the thread on `bb.artem.cool`, which goes
   through the homelab Cloudflare Tunnel: no login from the home IP, a
   Cloudflare Access email login elsewhere (homelab
   `applications/bb/README.md`). The user replies in bb.

## Architecture

```
agent ──telegram_notify──▶ plugin server ──sendMessage──▶ Telegram group
settings page ─Chats section─▶ plugin RPC ──getChat / getUpdates──▶ Telegram
```

The server entry runs on the bb coordinator (CT133 for `bb.artem.cool`) and
does all Telegram calls. The app entry only renders the Chats section and
talks to the server through plugin RPC; it never sees the token. No CLI,
webhook, or public port. Outbound HTTPS to `api.telegram.org` is the only
network need.

The bot calls `getUpdates` only when the user presses **Find groups** (see
[Find groups](#find-groups)); it never polls and never sets a webhook.

### SDK surfaces used (plugin SDK 0.6.49)

| Need | Surface |
| --- | --- |
| Agent action | `bb.agents.registerTool({ name: "telegram_notify", description, instructions, parameters: zod, execute(args, { threadId, projectId, signal }) })` |
| Offer it only when usable, and list the chats | `bb.agents.configure(ctx => usable(ctx) ? { tools: ["telegram_notify"], skills: [], instructions: chatList() } : { tools: [], skills: [] })`; `skills` is required, `instructions` is cut at 4096 chars |
| Token, limits | `bb.settings.define({ … })`; every setting needs a `label` |
| Chats section | app entry: `definePluginApp(app => app.slots.settingsSection({ id: "chats", title: "Chats", component }))`; shown on the plugin page below the settings form, also while the plugin needs configuration |
| Section ↔ server | `bb.rpc.register(defineRpcContract({ … }), handlers)` on the server, `useRpc<typeof contract>()` in the app |
| Live statuses | `bb.realtime.publish("chats", {})` on the server, `useRealtime` in the section, as `concurrency-limit` does |
| Section UI | vendored shadcn parts under `components/ui/` (table, input, button, checkbox), as `plugins/server-switcher` does |
| Thread facts | `bb.sdk.threads.get`, `bb.sdk.projects.get` |
| Link | `bb.server.experimental_appUrl` + `/projects/<projectId>/threads/<threadId>`, the route Telegram Projects uses |
| Chats, limits | `bb.storage.database()` + `migrate` |
| Background re-checks | `bb.background.service("check", { start(signal) })` |
| Missing token / no usable chat | `bb.status.needsConfiguration(...)`; a status only, the plugin keeps running; clears on the next load |

`configure` is synchronous, so the server keeps the chat list and each chat's status in memory: loaded from the database at
start, replaced on every save or check.

`package.json`:

```json
"bb": { "server": "./server.ts", "app": "./app.tsx" }
```

## Settings

Declarative settings (plugin settings form). All carry a `label`. Changes take
effect on `bb plugin reload telegram-notify`.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `botToken` | secret string | — | Stored as a 0600 file, never sent to the frontend or agents |
| `cooldownMinutes` | select `0,1,5,15,60` | `5` | Per thread |
| `hourlyLimit` | number 1–100 | `20` | All threads together |

Chats live in the plugin database, not in declarative settings, and are
edited only in the Chats section.

### Chats

Each chat has:

| Field | Rule |
| --- | --- |
| `name` | 1–32 chars, one line, unique ignoring case; what the agent passes as `chat` |
| `chatId` | integer; groups are negative |
| `use` | 0–120 chars, one line; shown to the agent as "when to use" |
| position | order in the table; the first chat is the default |

- At most **10 chats**, to keep the agent's instructions short.
- The same `chatId` can't appear twice.
- Saving validates the whole list in one transaction and replaces it; the
  section shows the first error and keeps the user's edits. A save applies to
  sends immediately and to agent instructions from each thread's next
  provider session.

### Chat check

The same three Bot API calls run for every chat, each with a 10-second
timeout:

1. `getMe`: the token works; remember the bot's user id (once per check
   round, not per chat).
2. `getChat`: the type is `group` or `supergroup` and not a forum. Channels
   and private chats are refused. Keep its `permissions` for step 3.
3. `getChatMember(chat, botId)`: the bot can post text if it is
   `administrator`; or `member` and the group's default
   `permissions.can_send_messages` is true; or `restricted` with
   `is_member` and `can_send_messages` both true. `left` and `kicked` can't.
   Ordinary membership is enough; the bot should **not** be an admin (see
   [Security](#security)).

A check runs for every chat after load (in the `check` service, so it can't
hit bb's 30-second load limit), for a changed or added chat on save, and for
one chat on the section's **Check** button. Each chat ends up `ready`,
`invalid` or `unknown`, and the section shows it with a plain reason:

- **invalid** (chat not found, wrong type, not a member, members can't
  post, bot restricted): that
  chat is refused by the tool with the same reason; the other chats keep
  working. Fixing it means editing the chat or the group, then **Check**.
- **unknown** (network error, timeout, 5xx, 429): temporary. The chat is
  still offered and sends normally; the service re-checks it with backoff
  (30 s → 15 min) until it gets a definite answer.

`needsConfiguration` is set only for problems the section can't fix: no
token, or the token is rejected (401). "No chats yet" and "every chat is
invalid" show as a notice at the top of the section instead, and the tool
isn't offered. No status is set for `unknown`.

Telegram reports a group that became a supergroup only when the bot tries
to post, so `sendMessage` handles `parameters.migrate_to_chat_id` too: the
send is `rejected` with "Home Admin moved to chat ID {new id}; update it in
Settings → Plugins → Telegram Notify". The chat is marked `invalid`, the new
ID is kept in the in-memory status as `migrateToChatId`, and the section
offers **Use new ID**, which fills it into the row; it takes effect only when
the user saves. The plugin never changes a chat on its own.

Statuses change outside the section too (background re-checks, a send that
finds a migration). On every change the server calls
`bb.realtime.publish("chats", {})`; the section listens with `useRealtime`,
calls `listChats` again and updates only the status column, so unsaved edits
survive.

### Find groups

The user presses **Find groups** to avoid looking up chat IDs:

1. The server calls `getUpdates` once with `timeout: 0` and no `offset`, so
   nothing is confirmed or removed. It doesn't pass `allowed_updates`, which
   would change the bot's update settings. A new bot's default delivers
   `my_chat_member`; a bot whose filter was changed elsewhere may not, and
   then Find groups finds nothing (use manual entry).
2. From the `my_chat_member` updates it keeps the latest per chat, then the
   chats where the bot is now `member` or `administrator` and the type is
   `group` or `supergroup`. Chats already in the table are left out.
3. The section lists them as `title (type)`; picking one adds a row with the
   ID filled in and the title as a suggested name, then checks it.

Telegram keeps updates for 24 hours and returns at most 100 per call, oldest
first. If none match, the section suggests removing the bot from the group,
adding it again and pressing Find groups, and offers manual entry. If 100
updates came back, it says the list may be incomplete. A `409` (a webhook is
set, or something else is calling `getUpdates` for this bot) shows Telegram's
description as is; the plugin doesn't delete webhooks.

### RPC contract

`defineRpcContract` in `contract.ts`, shared by both entries. All methods run
on the server; none returns the token or raw Bot API responses.

| Method | Input | Output |
| --- | --- | --- |
| `listChats` | `null` | `{ tokenSet, chats: [{ name, chatId, use, status, reason?, migrateToChatId? }] }` |
| `saveChats` | `{ chats: [{ name, chatId, use }] }` (in order) | `{ ok: true, list }` (the new `listChats` result) or `{ ok: false, row, error }` |
| `checkChat` | `{ chatId }` | `{ status, reason?, title? }` |
| `findGroups` | `null` | `{ groups: [{ chatId, title, type }], maybeIncomplete }` |

`chatId` crosses RPC as a decimal string. The input schema accepts
`/^-?\d{1,16}$/` and transforms it into a safe integer (Telegram chat IDs
have at most 52 significant bits); SQLite stores an `INTEGER`. bb validates
input before the handler runs, so only the checks a schema can't express
(duplicate names or IDs, the limit of 10) come back as `{ ok: false }`. A
schema failure or a network error rejects `rpc.call` instead; the section
catches both, shows the message and keeps the user's edits.

## Agent tool

`telegram_notify`

| Parameter | Type | Rule |
| --- | --- | --- |
| `title` | string | 1–80 chars, one line |
| `message` | string | 1–1000 chars |
| `chat` | string, optional | A chat name, matched ignoring case; omitted = the default chat |
| `silent` | boolean, default `false` | Sends with `disable_notification`, for FYI messages |

`chat` is a plain string in the schema, because the list changes without a
reload; `execute` checks it against the current list. An unknown name fails
with `unknown_chat` and lists the valid names; an invalid chat fails with
its reason.

`execute` uses `ctx.threadId`; the agent can't name another thread.

Results, as tool text:

- `Sent to Home Admin.` (the chat's name)
- error `unknown_chat`: "No chat named X. Chats: Home Admin, Home."
- error `chat_invalid`: the chat's check reason.
- error `cooldown`: "Sent one for this thread N minutes ago; try again after
  HH:MM or put it in your reply."
- error `hourly_limit`: the global cap was hit.
- error `rate_limited <seconds>`: Telegram said to wait (429); nothing was
  sent. "Try again after N seconds or put it in your reply." No automatic
  retry or waiting.
- error `rejected <description>`: Telegram refused it; nothing was sent.
- error `uncertain`: the request went out but no answer came back (10-second
  timeout, reset, 5xx). It may have arrived. "Don't retry; mention it in your reply."
  `sendMessage` has no idempotency key, so the plugin never retries either;
  a duplicate is worse than a gap.

**Eligibility** (`configure`): only when the token is accepted and at least
one chat isn't `invalid`, only for top-level threads
(`parentThreadId === null`; workers report to their parent), and not in side
chats (`origin.pluginId === "side-chat"`). Resolved tools apply from the
thread's next provider session.

**Instructions.** The tool snippet:

> Use `telegram_notify` to message the user on their phone when something
> deserves attention away from the screen: a requested report or long task is
> done, you found something they should know soon, or you are blocked on them.
> Don't use it for routine replies, progress updates, or anything the user is
> watching live. One message per task is typical. Never include secrets,
> tokens, passwords, or private keys.

`configure` adds the current chats as `instructions`, only when it offers
the tool (names and `use` notes are user text, so they're inserted as
one-line plain text, not markup):

> Telegram chats (pass the name as `chat`; omit it for the first):
> - Home Admin: infrastructure, reports, blockers
> - Home: household matters only
>
> Only post to a chat what its note says it's for.

## Limits

- **Per-thread cooldown** (`cooldownMinutes`, same values as #5724) and a
  **global hourly cap** (`hourlyLimit`), across all chats, so a runaway agent
  can't flood the groups. Both live in the plugin database and survive
  reloads.
- Check and reservation are one SQLite transaction: insert the `sends` row,
  then call Telegram, so concurrent calls can't all pass. A `rejected` or
  `rate_limited` send deletes its row; an `uncertain` one keeps it. Nothing
  waits or queues, so a reservation is never older than one 10-second
  request.

## Message format

`parse_mode: "HTML"`. The plugin owns the markup; every agent- or
thread-supplied field is truncated first, then escaped (`&`, `<`, `>`), so an
entity is never split:

```
🔔 <b>{title}</b>
{message}

<i>{project name} · {thread title}</i>
```

Every chat gets the same format, footer included. The footer shows the
project and thread names to everyone in the group, so a thread titled after
something private shows up in Home too if an agent posts there.

Project and thread names are cut to 64 characters, so a message stays under
~1250 characters, well inside Telegram's 4096. An inline keyboard button
**Open in bb** → `{appUrl}/projects/{projectId}/threads/{threadId}`; if
`appUrl` is null the button is left out. `link_preview_options:
{ is_disabled: true }`, so Telegram never tries to fetch the URL.

## Storage

Message text isn't stored.

```sql
CREATE TABLE chats (
  name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
  chat_id INTEGER NOT NULL UNIQUE,
  use TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL UNIQUE  -- 0 = default
);

CREATE TABLE sends (                -- cooldown and hourly cap
  thread_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX sends_thread_at ON sends (thread_id, at);
```

`sends` keeps the chat ID, not the name, so renaming a chat doesn't matter.
Rows older than a day are deleted on each send. Check statuses are in memory
only; they're recomputed after every load.

## Security

- **Send-only.** The plugin never acts on updates: **Find groups** reads them
  once, on the user's click, and uses only `my_chat_member` (who added the
  bot where). Message text in updates is ignored and never shown or stored.
  Telegram can't be used to steer agents.
- **A leaked token is more than "post as the bot".** Whoever has it can call
  `getUpdates` or set a webhook and see what the bot can see in its groups:
  even in privacy mode that includes replies to the bot, commands, and
  service messages. So keep BotFather's privacy mode **on**, and keep the bot
  an ordinary member, not an admin (admins see every message).
- **Token at rest.** bb writes secret settings to
  `<dataDir>/plugins/telegram-notify/secrets/botToken` (mode 0600; on
  `bb.artem.cool`, `/var/lib/bb/.bb/…` on CT133), never to bb's database. The
  settings API returns only `{ set: true }`, and the Chats section gets only
  `tokenSet`. The file isn't encrypted: the `bb` user, root on CT133, Proxmox
  admins and CT133 backups can read it, as can other plugins running in the
  same server, so install only trusted plugins. That matches Home Assistant's
  token (plain JSON in `.storage`); Grafana and Coolify encrypt theirs with a
  key on the same guest. Agents run on worker machines and can't read it. A
  leaked token is revoked in @BotFather and replaced in settings.
- The token never appears in logs, tool results, RPC results or errors. Bot
  API errors are logged without the request URL, which contains the token.
- A call without `chat` goes to the first chat, so keep the one only the
  user reads (Home Admin) at the top.
- Chat IDs aren't secret, but they stay out of Git like the token. Chat names
  and notes reach agents' instructions; the section says so.
- Outbound text leaves the homelab for Telegram's servers and is readable by
  every member of the target group, footer included. The instructions forbid
  secrets and point the agent at each chat's note; the plugin doesn't try to
  detect secrets.
- The link exposes the `bb.artem.cool` hostname and thread IDs to Telegram
  and to group members. Off the home IP, the URL still needs a Cloudflare
  Access email login, so it alone gives no access. Link previews stay off so
  Telegram doesn't fetch it.
- Plugin RPC is reachable by anyone who can use the bb server, as is the rest
  of its settings; bb has a single user, so the section adds no extra access
  checks.

## Testing

`@get-bb/plugin-sdk/testing` (`createFakePluginHost`) with an injected
`fetch` for the Bot API; `threads.get` and `projects.get` stubbed explicitly.

- Chat check: good chat; bad token → `needsConfiguration`; channel or forum
  ID; bot not a member, `left` or `kicked`; members barred from posting by
  group permissions; restricted bot with `is_member` false; network failure →
  `unknown` and re-check, no status; one invalid chat leaves the others
  working; no chats → tool not offered, no status.
- `saveChats`: duplicate names (any case) and IDs, more than 10, bad IDs
  (schema rejection), over-long fields; a failed save changes nothing; a
  good save updates the tool and instructions without a reload.
- Statuses: a background re-check or a send-time migration publishes on
  `chats`; `listChats` then returns `migrateToChatId`.
- `findGroups`: added/removed/re-added sequences keep the latest state;
  channels, private chats and already-listed groups dropped; message updates
  ignored; 100 updates → `maybeIncomplete`; 409 shows Telegram's
  description; `offset` and `allowed_updates` never sent.
- Tool: offered only when usable and top-level; validation; default chat;
  name matching ignoring case; `unknown_chat` lists names; invalid chat
  refused; cooldown and hourly cap across chats under concurrent calls;
  `rejected` vs `uncertain`; 429 → `rate_limited` and the reservation
  released; `migrate_to_chat_id` on send; HTML escaping of hostile titles;
  length budget with long names; no button without `appUrl`.
- Instructions: names and notes with markup or newlines stay one plain line
  each; none when the tool isn't offered.
- App: the section renders statuses, keeps edits after a failed save and
  after a rejected `rpc.call`, refreshes statuses on a realtime event
  without touching edits, fills a row from **Find groups** and from
  **Use new ID**; RPC is faked.

Live, on `bb.artem.cool`: add Home Admin with **Find groups**, send one
message from a thread, tap the link on the phone at home and away (Access
login), check the cooldown message, then add Home and send one there.

## Rollout

1. Build in `plugins/telegram-notify` of this repo; release
   `telegram-notify/v0.1.0`; add the marketplace entry.
2. Check CT133 can reach `api.telegram.org:443` (UniFi IPS has blocked worker
   traffic before; see the homelab UniFi notes).
3. User creates the bot, leaves privacy mode on, and adds it to Home Admin
   (and Home if wanted) as an ordinary member.
4. Install on `bb.artem.cool`; the user pastes the token and reloads.
5. In the Chats section, **Find groups** (or the IDs from Grafana's
   `Telegram admin` / `Telegram` contact points); Home Admin first, then
   Home. Chat IDs and the token stay out of Git.
6. Live-test. Record it in homelab `applications/bb/README.md` next to the
   other Telegram senders.
7. Optionally set `push-notifications` `defaultLevel` to `input-only`, so
   finished turns stop pushing and Telegram carries the reports.

## Out of scope

- Replies from Telegram, and acting on updates in any way.
- A CLI or automations sending through the plugin.
- Private chats, channels and forum topics.
- Per-project default chats (the agent can pick by name; revisit if that
  isn't enough).
- Child threads using the tool.

## History

- **v1 (two-way)**: replies in Telegram forwarded into the thread and the
  answer sent back. Codex reviewed it (bb thread `thr_4k7u6j474q`) and found
  15 issues, both high-severity ones in reply handling: possible duplicate
  delivery of a command to an agent with sudo, and answers forwarded to the
  wrong reply. That version is in Git history at `a6ddd7a`.
- **v2**: the user chose one-way. Review findings that still apply are
  kept: complete SDK examples, `rejected` vs `uncertain` sends, atomic limits,
  `needsConfiguration` instead of a "degraded" status, and the length budget.
- **v2.1**: Codex reviewed v2 (bb thread `thr_az9mv2ktdf`), 8 findings
  (7 medium, 1 low), all folded in: check membership and posting rights, not
  just `getChat`; handle supergroup migration on send; the link goes through
  Cloudflare Access, not LAN-only; no project/thread footer in Home; a leaked
  token can read what the bot sees, so privacy mode on and no admin; temporary
  check failures retry instead of needing a reload; 429 returns
  `rate_limited` instead of waiting; a bad Home ID doesn't disable Admin.
- **v2.2**: the user chose the plugin's own settings section over two
  fixed chat settings or a multiline text setting. Any number of named chats
  (up to 10) with a "when to use" note and a **Shared** flag, which
  generalizes v2.1's Home rules; **Find groups** replaces looking up IDs;
  chat edits need no reload.
- **v2.3**: the user dropped the Shared flag. Every chat is treated
  the same, footer included; the "when to use" note and the order (first =
  default) are the only per-chat rules.
- **v2.4 (this)**: Codex reviewed v2.3 (bb thread `thr_dpubhpmi3n`), 6
  findings (4 medium, 2 low), all folded in: the check uses the group's
  default permissions and `is_member`, not just the member status; chat IDs
  cross RPC as strings with a schema transform, and rejected calls keep
  edits; **Use new ID** gets its data from `migrateToChatId`; statuses reach
  an open section through realtime; Find groups explains its limits and
  shows 409s as Telegram describes them; the chat list goes into
  `configure`'s `instructions`, replacing `contributeInstructions`.
- **0.1.0 / 0.1.1 (built)**: built from v2.4 by a Sonnet 5.5 thread
  (`thr_9yhrx5a8rx`) and reviewed before release. SDK 0.6.49 matched the
  surfaces table. Differences from this spec:
  - The tool has one extra error, `not_configured`, for a missing or rejected
    token at send time.
  - `creator` counts as `administrator`; a `member` bot in a group that
    reports no `permissions` is `invalid`.
  - A 2xx reply whose body can't be read counts as no answer: `uncertain` on
    send, `unknown` on a check.
  - Telegram's error descriptions are cut to one line of 200 characters
    before they reach agents or the section.
  - The cooldown's "try again after HH:MM" uses the server's local time.
  - The section locks its controls while a save is in flight.
  - Tests run under `node --test` (server) and vitest with jsdom (section).
  - The icon is `BellDot`; bb has no `Bell`.
  - 0.1.0 didn't install: `@radix-ui/react-slot` was a devDependency, and git
    installs omit those. 0.1.1 moves it to `dependencies`.
