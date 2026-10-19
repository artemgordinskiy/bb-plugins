---
name: typography
description: Explain or troubleshoot the Typography plugin, which sets bb's chat reading typography, interface font and size, and the code and terminal fonts, with bundled or device fonts.
---

# Typography

Sets fonts and sizes in three areas:

- **Chat**: the markdown text of assistant replies and the user's own messages.
- **Interface**: bb's UI font and base text size.
- **Code**: the monospace font for code blocks, file views, diffs and the
  terminal.

## Configure

Settings → Plugins → Typography, with a live preview per area. There is no CLI
and no server-side setting. The config lives in the viewing browser's
localStorage under `bb-plugin-typography:config:v1`, so each device (and each
bb server origin) has its own. An agent cannot change it for the user; point
them to the settings page.

- **Chat** has its own on/off switch, presets (Book is the default: Literata
  17px, line height 1.65; also Editorial, Hyperlegible, Interface font), and
  tabs for Replies, Your messages, Headings, Code and Spacing.
- **Interface** has a font and a base size (11–17px). The base size scales
  all of bb's `--text-*` tokens; spacing is unchanged.
- **Code** has a code font (default JetBrains Mono), a terminal font (default:
  bb's Nerd Font stack; or "same as code font"), and ligatures (default off).
- The top **Typography** switch turns every rule off without losing settings.

## Fonts

Bundled: Literata, Source Serif 4, Atkinson Hyperlegible Next, JetBrains Mono
(OFL), served from `/api/v1/plugins/typography/http/font?file=<name>`.

Device fonts (e.g. Bookerly) are used by name and only render on devices that
have them installed. Listing them needs the Local Font Access API (Chromium,
HTTPS); otherwise the user types the name in the font menu.

## Troubleshooting

- **Interface or code font unchanged:** another plugin sets the same token
  with `!important`. The Fonts plugin does; the settings page shows a notice.
  Uninstall Fonts.
- **Terminal font unchanged:** terminals read the font when they open. Close
  and reopen the terminal.
- **Chat text unchanged after a bb update:** bb's message markup
  (`[data-message-column]`, `[data-markdown-preview]`, `group/message`) may
  have changed. Chat rules then have no effect until the plugin is updated.
- **A bundled font falls back to Georgia or the system font:** check that the
  font route returns 200 for a file listed in `font-faces.ts`.
