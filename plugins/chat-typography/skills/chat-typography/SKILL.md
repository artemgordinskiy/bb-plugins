---
name: chat-typography
description: Explain or troubleshoot the Chat Typography plugin, which restyles bb chat message text with bundled or device fonts, sizes, spacing and colors.
---

# Chat Typography

Restyles the markdown text of chat messages (assistant replies and the user's
own messages) and nothing else in bb.

## Configure

Settings → Plugins → Chat Typography, with a live preview. There is no CLI
and no server-side setting: the config lives in the viewing browser's
localStorage under `bb-plugin-chat-typography:config:v1`, so each device (and
each bb server origin) has its own. An agent cannot change it for the user;
point them to the settings page.

- Tabs: Replies, Your messages, Headings, Code, Spacing.
- Presets: Book (default: Literata 17px, line height 1.65), Editorial
  (Source Serif 4), Hyperlegible (Atkinson Hyperlegible Next), Theme fonts.
- **Restyle chat messages** switches every rule off without losing settings.

## Fonts

Bundled: Literata, Source Serif 4, Atkinson Hyperlegible Next, JetBrains Mono
(OFL), served from `/api/v1/plugins/chat-typography/http/font?file=<name>`.
Device fonts (e.g. Bookerly) are used by name and only render on devices that
have them installed. Listing them needs the Local Font Access API (Chromium,
HTTPS); otherwise the user types the name in the font menu.

## Troubleshooting

- Text unchanged after a bb update: bb's message markup
  (`[data-message-column]`, `[data-markdown-preview]`, `group/message`) may
  have changed; the plugin then has no effect until updated.
- A bundled font falls back to Georgia or the system sans: check the font
  route returns 200 for a file listed in `font-faces.ts`.
