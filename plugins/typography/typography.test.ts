import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BB_THEME,
  DEFAULT_CONFIG,
  PRESETS,
  SCOPES,
  buildFontFaces,
  buildStylesheet,
  parseConfig,
  sanitizeFamily,
  type TypographyConfig,
} from "./typography.ts";

function withChat(patch: Partial<TypographyConfig["chat"]>): TypographyConfig {
  return { ...DEFAULT_CONFIG, chat: { ...DEFAULT_CONFIG.chat, ...patch } };
}

/** The declarations of the `html:root` rule, or "" without one. */
function rootRule(css: string): string {
  return /^html:root\{([^}]*)\}/m.exec(css)?.[1] ?? "";
}

test("missing or malformed storage yields the defaults", () => {
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig("nope"), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ interface: 4, code: [], chat: { replies: "x" } }), DEFAULT_CONFIG);
});

test("a saved config round-trips", () => {
  const config: TypographyConfig = {
    ...DEFAULT_CONFIG,
    interface: { font: { kind: "bundled", id: "atkinson-hyperlegible-next" }, size: 14.5 },
    code: { font: { kind: "device", family: "Berkeley Mono" }, ligatures: true, terminal: { kind: "same" } },
    chat: {
      ...DEFAULT_CONFIG.chat,
      replies: { ...DEFAULT_CONFIG.chat.replies, font: { kind: "device", family: "Bookerly" }, size: 18.5 },
      messages: { ...DEFAULT_CONFIG.chat.messages, color: { light: "#333333", dark: "#e0dcd2" } },
    },
  };
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(config))), config);
});

test("numbers are clamped and bad fields fall back individually", () => {
  const config = parseConfig({
    interface: { size: 40 },
    code: { terminal: { kind: "bundled", id: "comic-mono" } },
    chat: {
      replies: { size: 400, lineHeight: "tall", font: { kind: "bundled", id: "comic-sans" } },
      messages: { color: { light: "red", dark: "#ABCDEF" } },
    },
  });
  assert.equal(config.interface.size, 17);
  assert.deepEqual(config.code.terminal, DEFAULT_CONFIG.code.terminal);
  assert.equal(config.chat.replies.size, 26);
  assert.equal(config.chat.replies.lineHeight, DEFAULT_CONFIG.chat.replies.lineHeight);
  assert.deepEqual(config.chat.replies.font, DEFAULT_CONFIG.chat.replies.font);
  assert.deepEqual(config.chat.messages.color, { light: null, dark: "#abcdef" });
});

test("device font names cannot break out of the CSS string", () => {
  assert.equal(sanitizeFamily('Evil"}body{display:none'), "Evilbodydisplay:none");
  const css = buildStylesheet(
    parseConfig({ ...DEFAULT_CONFIG, interface: { font: { kind: "device", family: 'X";}*{color:red' }, size: null } }),
  );
  assert.ok(rootRule(css).startsWith('--font-sans:"X*color:red", "Inter Variable"'));
});

test("the defaults keep the interface and move code to JetBrains Mono", () => {
  const root = rootRule(buildStylesheet(DEFAULT_CONFIG));
  assert.ok(!root.includes("--font-sans"));
  assert.ok(!root.includes("--text-"));
  assert.ok(root.includes('--font-mono:"JetBrains Mono", ui-monospace'));
  assert.ok(root.includes('--diffs-font-family:"JetBrains Mono", ui-monospace'));
  assert.ok(root.includes('--diffs-font-features:"liga" 0, "calt" 0'));
  // The terminal keeps bb's Nerd Font stack unless asked to follow the code font.
  assert.ok(!root.includes("--font-terminal"));
});

test("overrides fall back to the theme's literal stacks, never to themselves", () => {
  const css = buildStylesheet({
    ...DEFAULT_CONFIG,
    interface: { font: { kind: "device", family: "SF Pro Text" }, size: null },
    code: { ...DEFAULT_CONFIG.code, terminal: { kind: "same" } },
  });
  const root = rootRule(css);
  assert.ok(!/--font-(sans|mono|terminal):[^;]*var\(--font-/.test(root));
  assert.ok(root.includes(`--font-sans:"SF Pro Text", ${BB_THEME.fontSans}`));
  assert.ok(root.includes(`--font-terminal:"JetBrains Mono", ${BB_THEME.fontTerminal}`));
});

test("an interface size scales the theme's whole text scale", () => {
  const theme = { ...BB_THEME, text: { "--text-xs": 12, "--text-sm": 13, "--text-lg": 18 } };
  const config = { ...DEFAULT_CONFIG, interface: { ...DEFAULT_CONFIG.interface, size: 15 } };
  const root = rootRule(buildStylesheet(config, theme));
  assert.ok(root.includes("--text-xs:13.846px"));
  assert.ok(root.includes("--text-sm:15px"));
  assert.ok(root.includes("--text-lg:20.769px"));
  assert.ok(!root.includes("--text-base"));
});

test("ligatures stay on when chosen", () => {
  const css = buildStylesheet({ ...DEFAULT_CONFIG, code: { ...DEFAULT_CONFIG.code, ligatures: true } });
  assert.ok(!css.includes("--diffs-font-features"));
  assert.ok(!css.includes("font-variant-ligatures"));
});

test("the default chat stylesheet styles replies and your messages", () => {
  const css = buildStylesheet(DEFAULT_CONFIG);
  assert.ok(css.includes(`${SCOPES.replies}{`));
  assert.ok(css.includes(`${SCOPES.messages}{`));
  assert.match(css, /font-family:"Literata", Georgia/);
  assert.match(css, /font-size:17px;line-height:1\.65/);
  assert.match(css, /html\.dark :is\(\[data-message-column\]\.group\\\/message[^{]*\{font-weight:380\}/);
  // Chat code follows the app's code font by default.
  assert.match(css, /\[data-markdown-preview\] :is\(code, kbd, samp\)\{font-family:"JetBrains Mono", ui-monospace[^;]*!important/);
  // Theme colors stay untouched until a color is chosen.
  assert.ok(!css.includes("--foreground"));
});

test("colors apply per appearance", () => {
  const css = buildStylesheet(
    withChat({ replies: { ...DEFAULT_CONFIG.chat.replies, color: { light: "#2b2b2b", dark: null } } }),
  );
  assert.ok(css.includes(`html:not(.dark) ${SCOPES.replies}{--foreground:#2b2b2b}`));
  assert.ok(!css.includes(`html.dark ${SCOPES.replies}{--foreground`));
});

test("chat can be switched off on its own", () => {
  const css = buildStylesheet(withChat({ enabled: false }));
  assert.ok(!css.includes("[data-markdown-preview]"));
  assert.ok(rootRule(css).includes("--font-mono"));
});

test("switching the plugin off removes every rule", () => {
  assert.equal(buildStylesheet({ ...DEFAULT_CONFIG, enabled: false }), "");
});

test("the Book preset is the default chat look", () => {
  const book = PRESETS.find((preset) => preset.id === "book");
  assert.ok(book);
  assert.deepEqual(book.apply(DEFAULT_CONFIG.chat), DEFAULT_CONFIG.chat);
});

test("font faces point at the plugin route with their unicode range", () => {
  const css = buildFontFaces(
    [{ font: "literata", style: "italic", file: "literata-italic-latin.woff2", unicodeRange: "U+0000-00FF" }],
    "/fonts",
  );
  assert.equal(
    css,
    '@font-face{font-family:"Literata";font-style:italic;font-weight:200 900;font-display:swap;src:url("/fonts?file=literata-italic-latin.woff2") format("woff2");unicode-range:U+0000-00FF}',
  );
});
