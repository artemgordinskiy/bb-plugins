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
  terminalFace,
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
    code: { font: { kind: "device", family: "Berkeley Mono" }, ligatures: true, terminal: { kind: "same" }, terminalCell: 9 },
    chat: {
      ...DEFAULT_CONFIG.chat,
      replies: { ...DEFAULT_CONFIG.chat.replies, font: { kind: "device", family: "Bookerly" }, size: 18.5 },
      messages: { ...DEFAULT_CONFIG.chat.messages, color: { light: "#333333", dark: "#e0dcd2" } },
    },
  };
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(config))), config);
});

test("a saved null keeps the theme's value even where the default sets one", () => {
  const config = parseConfig({
    interface: { size: null },
    chat: { replies: { color: { light: null, dark: null } } },
  });
  assert.equal(config.interface.size, null);
  assert.deepEqual(config.chat.replies.color, { light: null, dark: null });
  assert.equal(parseConfig({ chat: { replies: { color: { dark: "teal" } } } }).chat.replies.color.dark, "#dedede");
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

test("the defaults set the interface in Atkinson at 15px and code everywhere in JetBrains Mono", () => {
  const root = rootRule(buildStylesheet(DEFAULT_CONFIG));
  assert.ok(root.includes('--font-sans:"Atkinson Hyperlegible Next", ui-sans-serif, system-ui, sans-serif;'));
  assert.ok(root.includes("--text-sm:15px"));
  assert.ok(root.includes('--font-mono:"JetBrains Mono", ui-monospace'));
  assert.ok(root.includes('--diffs-font-family:"JetBrains Mono", ui-monospace'));
  // Ligatures are on, so nothing turns them off.
  assert.ok(!root.includes("--diffs-font-features"));
  // The terminal follows the code font through its cell-sized alias, with bb's Nerd Font stack behind it.
  assert.ok(root.includes(`--font-terminal:"JetBrains Mono Terminal", ${BB_THEME.fontTerminal}`));
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
  assert.ok(root.includes(`--font-terminal:"JetBrains Mono Terminal", ${BB_THEME.fontTerminal}`));
});

test("a bundled terminal font fills whole-pixel cells exactly", () => {
  const face = terminalFace(DEFAULT_CONFIG);
  assert.ok(face);
  // 8px cells: 13.35px JetBrains Mono is 8.01px wide, which xterm floors to 8 at any pixel ratio.
  assert.ok(Math.abs(face.size * 0.6 - 8.01) < 1e-9);
  for (const ratio of [1, 2, 3]) assert.equal(Math.floor(face.size * 0.6 * ratio), 8 * ratio);
  const faces = [
    { font: "jetbrains-mono", style: "normal", file: "jb.woff2", unicodeRange: "U+0000-00FF" },
    { font: "literata", style: "normal", file: "lit.woff2", unicodeRange: "U+0000-00FF" },
  ];
  const css = buildFontFaces(faces, "/fonts", face).split("\n");
  assert.equal(css.length, 3);
  assert.match(css[2] ?? "", /^@font-face\{font-family:"JetBrains Mono Terminal";.*file=jb\.woff2.*;size-adjust:111\.25%\}$/);
  // A device or theme terminal font keeps bb's 12px and its own name.
  const device = { ...DEFAULT_CONFIG, code: { ...DEFAULT_CONFIG.code, terminal: { kind: "device", family: "Menlo" } } } as const;
  assert.equal(terminalFace(device), null);
  assert.ok(rootRule(buildStylesheet(device)).includes('--font-terminal:"Menlo", '));
  assert.equal(parseConfig({ code: { terminalCell: 8.6 } }).code.terminalCell, 9);
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

test("ligatures can be switched off everywhere", () => {
  const css = buildStylesheet({ ...DEFAULT_CONFIG, code: { ...DEFAULT_CONFIG.code, ligatures: false } });
  assert.ok(rootRule(css).includes('--diffs-font-features:"liga" 0, "calt" 0'));
  assert.ok(css.includes("font-variant-ligatures:none"));
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
  // Replies are a softer white in dark mode; light mode keeps the theme's color.
  assert.ok(css.includes(`html.dark ${SCOPES.replies}{--foreground:#dedede}`));
  assert.ok(!css.includes("html:not(.dark)"));
});

test("the message box takes your messages' type unless switched off", () => {
  const lines = buildStylesheet(DEFAULT_CONFIG).split("\n");
  const box = lines.find((line) => line.startsWith(`${SCOPES.composer}{`)) ?? "";
  assert.match(box, /font-family:"Literata", Georgia/);
  assert.match(box, /font-size:16px;line-height:1\.6;font-weight:400/);
  assert.ok(lines.includes(`html.dark ${SCOPES.composer}{font-weight:380}`));
  const off = buildStylesheet(withChat({ messages: { ...DEFAULT_CONFIG.chat.messages, composer: false } }));
  assert.ok(!off.includes("promptbox"));
});

test("the assistant's thinking reads in the replies' type and keeps bb's color", () => {
  const lines = buildStylesheet(
    withChat({ replies: { ...DEFAULT_CONFIG.chat.replies, color: { light: "#2b2b2b", dark: "#e0dcd2" } } }),
  ).split("\n");
  const thinking = lines.find((line) => line.startsWith(`${SCOPES.thinking}{`)) ?? "";
  assert.match(thinking, /font-family:"Literata", Georgia/);
  assert.match(thinking, /font-size:17px;line-height:1\.65;font-weight:400/);
  assert.ok(lines.includes(`html.dark ${SCOPES.thinking}{font-weight:380}`));
  assert.ok(!lines.some((line) => line.includes(SCOPES.thinking) && /color|--foreground/.test(line)));
  assert.ok(!buildStylesheet(withChat({ enabled: false })).includes("data-timeline-items"));
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
