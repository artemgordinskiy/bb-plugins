# Telegram Notify: technical spec

Status: draft v2.2, 2026-10-21. Not built yet. One-way only; chats are
managed in the plugin's own settings section (see [History](#history)).

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

   | Name | When to use | Shared | Status |
   | --- | --- | --- | --- |
   | Home Admin (default) | infrastructure, reports, blockers | | ✓ ready |
   | Home | household matters only | ✓ | ✓ ready |

   **Find groups** lists the groups the bot was added to in the last 24 hours;
   picking one fills in its ID and title. **Add** takes a chat ID by hand (the
   same IDs Grafana's contact points use). Each row has a name, a "when to
   use" note for the agent, a **Shared** box for groups other people read,
   and a live check. Rows can be reordered; the first is the default. Saving
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
| Offer it only when usable | `bb.agents.configure(ctx => ({ tools: hasReadyChat && eligible(ctx) ? ["telegram_notify"] : [], skills: [] }))`; `skills` is required |
| List the chats for the agent | `bb.agents.contributeInstructions(ctx => text)` |
| Token, limits | `bb.settings.define({ … })`; every setting needs a `label` |
| Chats section | app entry: `definePluginApp(app => app.slots.settingsSection({ id: "chats", title: "Chats", component }))`; shown on the plugin page below the settings form, also while the plugin needs configuration |
| Section ↔ server | `bb.rpc.register(defineRpcContract({ … }), handlers)` on the server, `useRpc<typeof contract>()` in the app |
| Section UI | vendored shadcn parts under `components/ui/` (table, input, button, checkbox), as `plugins/server-switcher` does |
| Thread facts | `bb.sdk.threads.get`, `bb.sdk.projects.get` |
| Link | `bb.server.experimental_appUrl` + `/projects/<projectId>/threads/<threadId>`, the route Telegram Projects uses |
| Chats, limits | `bb.storage.database()` + `migrate` |
| Background re-checks | `bb.background.service("check", { start(signal) })` |
| Missing token / no usable chat | `bb.status.needsConfiguration(...)`; a status only, the plugin keeps running; clears on the next load |

`configure` and `contributeInstructions` are synchronous, so the server keeps
the chat list and each chat's status in memory: loaded from the database at
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
| `shared` | boolean; the group is read by people other than the user |
| position | order in the table; the first chat is the default |

- At most **10 chats**, to keep the agent's instructions short.
- The default (first) chat **can't be shared**: a call without `chat` must
  never land in a group other people read.
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
   and private chats are refused.
3. `getChatMember(chat, botId)`: the bot is `member` or `administrator`, or
   `restricted` with `can_send_messages`. Ordinary membership is enough; the
   bot should **not** be an admin (see [Security](#security)).

A check runs for every chat after load (in the `check` service, so it can't
hit bb's 30-second load limit), for a changed or added chat on save, and for
one chat on the section's **Check** button. Each chat ends up `ready`,
`invalid` or `unknown`, and the section shows it with a plain reason:

- **invalid** (chat not found, wrong type, not a member, can't post): that
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
send is `rejected` with "Home Admin moved to a new chat ID; update it in
Settings → Plugins → Telegram Notify". The chat is marked `invalid` and the
section offers **Use new ID** with the ID Telegram returned; the plugin
never changes a chat on its own.

### Find groups

The user presses **Find groups** to avoid looking up chat IDs:

1. The server calls `getUpdates` once with `timeout: 0` and no `offset`, so
   nothing is confirmed or removed. It doesn't pass `allowed_updates`, which
   would change the bot's update settings; `my_chat_member` is delivered by
   default.
2. From the `my_chat_member` updates it keeps the latest per chat, then the
   chats where the bot is now `member` or `administrator` and the type is
   `group` or `supergroup`. Chats already in the table are left out.
3. The section lists them as `title (type)`; picking one adds a row with the
   ID filled in and the title as a suggested name, then checks it.

Telegram keeps updates for 24 hours and returns at most 100 per call, oldest
first. If none match, the section says "Remove the bot from the group and
add it again, then press Find groups" and offers manual entry. If 100
updates came back, it says the list may be incomplete. A `409` (a webhook is
set on this bot) is shown as such; the plugin doesn't delete webhooks.

### RPC contract

`defineRpcContract` in `contract.ts`, shared by both entries. All methods run
on the server; none returns the token or raw Bot API responses.

| Method | Input | Output |
| --- | --- | --- |
| `listChats` | `null` | `{ tokenSet, chats: [{ name, chatId, use, shared, status, reason? }] }` |
| `saveChats` | `{ chats: [{ name, chatId, use, shared }] }` (in order) | the new `listChats` result, or `{ ok: false, error }` naming the bad row |
| `checkChat` | `{ chatId }` | `{ status, reason?, title? }` |
| `findGroups` | `null` | `{ groups: [{ chatId, title, type }], maybeIncomplete }` |

Telegram chat IDs have at most 52 significant bits, so `chatId` is a plain
number in RPC and an `INTEGER` in SQLite. The section's input is text,
parsed as an integer on the server.

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

`contributeInstructions` adds the current chats (names and `use` notes are
user text, so they're inserted as one-line plain text, not markup):

> Telegram chats (pass the name as `chat`; omit it for the first):
> - Home Admin: infrastructure, reports, blockers
> - Home (shared, other people read it): household matters only
>
> Only use a shared chat for what its note says, and never put
> infrastructure details or anything private about the user in it.

It returns `null` when the tool isn't offered.

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

Shared chats get no footer: project and thread names can say things about the
infrastructure or the user that the agent never chose to share with others.
The agent's `title` and `message` are the only text, and the button still
opens the thread.

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
  shared INTEGER NOT NULL DEFAULT 0,
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
- **The default chat can't be shared**, and shared chats get no footer, so
  an agent that forgets `chat` never posts to the household.
- Chat IDs aren't secret, but they stay out of Git like the token. Chat names
  and notes reach agents' instructions; the section says so.
- Outbound text leaves the homelab for Telegram's servers and is readable by
  every member of the target group. The instructions forbid secrets and keep
  private details out of shared chats; the plugin doesn't try to detect
  secrets.
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
  ID; bot not a member; bot restricted from posting; network failure →
  `unknown` and re-check, no status; one invalid chat leaves the others
  working; no chats → tool not offered, no status.
- `saveChats`: duplicate names (any case) and IDs, more than 10, shared
  default, bad IDs, over-long fields; a failed save changes nothing; a good
  save updates the tool and instructions without a reload.
- `findGroups`: added/removed/re-added sequences keep the latest state;
  channels, private chats and already-listed groups dropped; message updates
  ignored; 100 updates → `maybeIncomplete`; 409; `offset` never sent.
- Tool: offered only when usable and top-level; validation; default chat;
  name matching ignoring case; `unknown_chat` lists names; invalid chat
  refused; cooldown and hourly cap across chats under concurrent calls;
  `rejected` vs `uncertain`; 429 → `rate_limited` and the reservation
  released; `migrate_to_chat_id` on send; HTML escaping of hostile titles;
  length budget with long names; no footer in a shared chat even with a
  sensitive thread title; no button without `appUrl`.
- Instructions: shared chats marked; names and notes with markup or newlines
  stay one plain line each; `null` when not offered.
- App: the section renders statuses, blocks saving a shared default, keeps
  edits after a failed save, and fills a row from **Find groups**; RPC is
  faked.

Live, on `bb.artem.cool`: add Home Admin with **Find groups**, send one
message from a thread, tap the link on the phone at home and away (Access
login), check the cooldown message, then add Home as shared and confirm it
gets no footer.

## Rollout

1. Build in `plugins/telegram-notify` of this repo; release
   `telegram-notify/v0.1.0`; add the marketplace entry.
2. Check CT133 can reach `api.telegram.org:443` (UniFi IPS has blocked worker
   traffic before; see the homelab UniFi notes).
3. User creates the bot, leaves privacy mode on, and adds it to Home Admin
   (and Home if wanted) as an ordinary member.
4. Install on `bb.artem.cool`; the user pastes the token and reloads.
5. In the Chats section, **Find groups** (or the IDs from Grafana's
   `Telegram admin` / `Telegram` contact points); Home Admin first, Home
   marked shared. Chat IDs and the token stay out of Git.
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
- **v2.2 (this)**: the user chose the plugin's own settings section over two
  fixed chat settings or a multiline text setting. Any number of named chats
  (up to 10) with a "when to use" note and a **Shared** flag, which
  generalizes v2.1's Home rules; **Find groups** replaces looking up IDs;
  chat edits need no reload. Not reviewed yet.
