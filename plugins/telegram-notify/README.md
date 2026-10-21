# Telegram Notify

Gives agents a `telegram_notify` tool that sends you a Telegram message with a
title, a short body and an **Open in bb** button that links back to the thread.
It only sends: the plugin never reads what people write in Telegram, so
Telegram can't be used to steer agents.

## Configure

1. Create a bot with @BotFather and add it to the group or groups you want
   messages in. Keep BotFather's privacy mode on and leave the bot an ordinary
   member, not an admin.
2. Set the plugin's settings, then reload it:

   | Setting | Default | Notes |
   | --- | --- | --- |
   | `botToken` | none | Secret. Stored as a private file on the bb server and never shown again |
   | `cooldownMinutes` | `5` | Least time between two messages from the same thread; `0` turns it off |
   | `hourlyLimit` | `20` | Most messages all threads together may send in an hour |

   ```sh
   bb plugin config telegram-notify set botToken '<token from BotFather>'
   bb plugin reload telegram-notify
   ```

   Settings are read when the plugin loads, so reload after changing any of them.
3. In **Settings → Plugins → Telegram Notify**, use the **Chats** section to
   list where agents may post. Each chat has a name (what the agent passes as
   `chat`), a Telegram chat ID, and an optional note saying when to use it.
   **Find groups** lists groups the bot was recently added to and fills in the
   ID and title when you pick one; **Check** tests a chat on demand. The first
   chat is the default, and rows can be reordered. Saving needs no reload.

## Behavior

- The tool is offered only to top-level threads, and only while the token is
  accepted and at least one chat is not marked invalid. The chat names and
  notes are added to the thread's instructions at the start of its next
  provider session.
- A call without `chat` goes to the first chat, so put the chat only you read at
  the top.
- Chats are checked after the plugin loads, when saved, and on **Check**. A chat
  the bot can't post to is marked invalid with a reason, and the tool refuses
  it. If Telegram can't be reached the chat stays usable and is checked again
  in the background, waiting longer each time up to 15 minutes.
- At most 10 chats, 32 characters per name, 120 per note.
- Titles are at most 80 characters and bodies at most 1000. The plugin builds
  the message itself and escapes what agents supply; link previews are off.
- A send that Telegram never answers is reported to the agent as `uncertain`
  and still counts toward the limits, so it won't be retried blindly.
- Whatever an agent sends is readable by everyone in the target group,
  including the footer with the project and thread names. The instructions tell
  agents to leave secrets out, but the plugin doesn't try to detect them.
- The bot token is never put in logs, tool results or RPC results.

## Develop

```sh
npm install
npm run typecheck
npm test
bb plugin build
```

`npm test` runs the backend and state tests with `node --test` and the settings
section tests with vitest and jsdom. The tests use a fake Bot API and fake
tokens, never the network.
