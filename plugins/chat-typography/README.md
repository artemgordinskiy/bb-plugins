# Chat Typography

Book-like typography for bb chat messages. Restyles the text of assistant
replies and your own messages, and nothing else in bb, so the interface keeps
its theme while long replies read like a page.

Defaults: Literata at 17px with a 1.65 line height, your messages at 16px,
JetBrains Mono for code at 84% of the surrounding text, slightly lighter
weight in dark mode, and wider paragraph gaps. Colors follow the theme until
you pick your own.

## Settings

Settings → Plugins → Chat Typography. Changes apply to open threads at once
and show in a live preview.

| Tab | Controls |
| --- | --- |
| Replies | font, size, line height, weight, letter spacing, light and dark text color |
| Your messages | the same, with the font defaulting to "same as replies" |
| Headings | font, weight, size scale, letter spacing, color |
| Code | font, size relative to text, block line height, ligatures |
| Spacing | paragraph spacing, dark mode weight offset, even line endings, hyphenation, optical sizing |

Presets (Book, Editorial, Hyperlegible, Theme fonts) set faces, sizes and
spacing and keep your colors. Color swatches show WCAG contrast against the
real message background for the appearance on screen.

Settings are stored per device in the browser's localStorage, so a phone and
a desktop can differ. Every open bb tab on the device follows a change.

## Fonts

Included, all SIL Open Font License 1.1 variable fonts (licenses in
[fonts/](fonts)):

- Literata — book serif, with optical sizes
- Source Serif 4 — transitional serif, with optical sizes
- Atkinson Hyperlegible Next — high-legibility sans
- JetBrains Mono — code

They ship as per-script woff2 subsets (Latin, Latin Extended, Cyrillic,
Cyrillic Extended, Greek where the font has them) served by the plugin's own
backend at `/api/v1/plugins/chat-typography/http/font`; a browser downloads
only the subsets the text on screen uses. No requests leave the bb server.

Any font installed on the viewing device can be used too. In Chromium
browsers and the desktop app, **Find fonts on this device** lists them through
the Local Font Access API (one permission prompt). Elsewhere, type the font's
name in the font menu's search box; the plugin checks that it is installed.
Device fonts such as Bookerly are never uploaded or bundled.

## How it works

A content script adds two `<style>` elements: `@font-face` rules for the
bundled fonts, and rules generated from the saved config
([typography.ts](typography.ts)). The rules target bb's markdown root
`[data-markdown-preview]` inside a chat message's `[data-message-column]`;
replies are the column with the `group/message` class, your messages the one
without. bb's size tokens are re-based to `em` inside that scope, so inline
code and small labels scale with the text. Code fonts and sizes are
`!important` so the Fonts plugin's global code rule does not override chat
code.

These selectors match bb 0.46. If a bb update changes the message markup, the
plugin stops matching and bb's own styling shows; nothing breaks.

## Develop

```sh
npm install
npm test             # typography model tests
bb plugin build
bb plugin install .  # from a checkout on the bb server
```
