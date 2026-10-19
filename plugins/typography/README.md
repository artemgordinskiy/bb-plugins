# Typography

Fonts and sizes for bb, in three areas:

- **Chat** — book-like reading typography for assistant replies and your own
  messages. The message box uses your messages' type by default.
- **Interface** — the font and base size of bb's own UI: sidebar, menus and
  settings.
- **Code** — one monospace font for code blocks, file views, diffs and the
  terminal.

Defaults change only what helps reading. The interface keeps the theme's face
and scale. Code everywhere moves to JetBrains Mono with ligatures off, and the
terminal keeps bb's Nerd Font stack. Chat is set in Literata at 17px with a
1.65 line height, with your messages and the message box at 16px. Code in chat is 84% of the
surrounding text. Dark mode uses a slightly lighter weight, and paragraph
gaps are wider. Colors follow the theme until you pick your own.

## Settings

Settings → Plugins → Typography. Changes apply to the whole app at once, with
a live preview for each area. Each area has its own **Reset**, and the top
switch turns every rule off without losing settings.

| Area | Controls |
| --- | --- |
| Chat | on/off, presets, and tabs for Replies, Your messages, Headings, Code and Spacing |
| Interface | font; base size (11–17px), which scales bb's whole text scale |
| Code | code font, terminal font ("same as code font" or bb's own), ligatures |

The chat tabs hold these controls:

| Chat tab | Controls |
| --- | --- |
| Replies | font, size, line height, weight, letter spacing, light and dark text color |
| Your messages | the same, with the font defaulting to "same as replies"; whether the message box uses this type (on by default) |
| Headings | font, weight, size scale, letter spacing, color |
| Code | font ("same as code font" by default), size relative to text, block line height |
| Spacing | paragraph spacing, dark mode weight offset, even line endings, hyphenation, optical sizing |

The chat presets are Book, Editorial, Hyperlegible and Interface font. They
set faces, sizes and spacing and keep your colors. Color swatches show WCAG
contrast against the real message background for the appearance on screen.

Settings are stored per device in the browser's localStorage, so a phone and
a desktop can differ. Every open bb tab on the device follows a change.

## Fonts

All the included fonts are SIL Open Font License 1.1 variable fonts
(licenses in [fonts/](fonts)):

- Literata — book serif, with optical sizes
- Source Serif 4 — transitional serif, with optical sizes
- Atkinson Hyperlegible Next — high-legibility sans
- JetBrains Mono — code

They ship as per-script woff2 subsets (Latin, Latin Extended, Cyrillic,
Cyrillic Extended, and Greek where the font has them). The plugin's own
backend serves them at `/api/v1/plugins/typography/http/font`. A browser
downloads only the subsets the text on screen uses, and no requests leave the
bb server.

Any font installed on the viewing device can be used too:

- In Chromium browsers and the desktop app, **Find fonts on this device**
  lists them through the Local Font Access API (one permission prompt).
- Elsewhere, type the font's name in the font menu's search box; the plugin
  checks that it is installed.

Device fonts such as Bookerly are never uploaded or bundled.

## The Fonts plugin

This plugin covers what the Fonts plugin does (interface and code fonts), so
uninstall Fonts once Typography is set up. While both are installed, Fonts'
`!important` rules win for any area Fonts sets. Typography's settings page
says so when it detects this.

## How it works

A content script adds two `<style>` elements: `@font-face` rules for the
bundled fonts, and rules generated from the saved config
([typography.ts](typography.ts)).

- **Interface and code** set bb's root tokens: `--font-sans`, `--font-mono`,
  `--font-terminal`, `--text-*`, and `--diffs-font-family` /
  `--diffs-font-features` for the diff and file viewers, which render in
  shadow DOM.
  - Overrides fall back to the theme's own stacks. The plugin reads them from
    the page with its rules switched off, and reads them again when the theme
    or appearance changes.
  - Diff sizes are left alone because bb's virtualized diff view depends on
    its line height.
  - The terminal measures its font when it opens, so a new terminal font
    shows in terminals opened afterwards. A bundled terminal font is loaded
    up front for that reason.
- **Chat** rules target bb's markdown root `[data-markdown-preview]` inside a
  chat message's `[data-message-column]`. Replies are the column with the
  `group/message` class; your messages are the one without.
  - bb's size tokens are re-based to `em` inside that scope, so inline code
    and small labels scale with the text.
  - Chat code fonts and sizes are `!important` so another plugin's global
    code rule does not override them.
  - The message box is the ProseMirror editor inside
    `[data-promptbox-editor-content]`. It takes your messages' font, size,
    line height, weight and letter spacing, but not their color, paragraph
    spacing or wrapping, so earlier lines do not reflow while you type.

These selectors and tokens match bb 0.46. If a bb update changes them, the
affected rules stop matching and bb's own styling shows; nothing breaks.

## Develop

```sh
npm install
npm test             # typography model tests
bb plugin build
bb plugin install .  # from a checkout on the bb server
```
