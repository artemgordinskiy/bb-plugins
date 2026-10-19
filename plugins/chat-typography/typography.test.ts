import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  PRESETS,
  SCOPES,
  buildFontFaces,
  buildStylesheet,
  parseConfig,
  sanitizeFamily,
} from "./typography.ts";

test("missing or malformed storage yields the defaults", () => {
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig("nope"), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ replies: 4, code: [] }), DEFAULT_CONFIG);
});

test("a saved config round-trips", () => {
  const config = {
    ...DEFAULT_CONFIG,
    replies: { ...DEFAULT_CONFIG.replies, font: { kind: "device", family: "Bookerly" }, size: 18.5 },
    messages: { ...DEFAULT_CONFIG.messages, color: { light: "#333333", dark: "#e0dcd2" } },
  } as const;
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(config))), config);
});

test("numbers are clamped and bad fields fall back individually", () => {
  const config = parseConfig({
    replies: { size: 400, lineHeight: "tall", font: { kind: "bundled", id: "comic-sans" } },
    messages: { color: { light: "red", dark: "#ABCDEF" } },
  });
  assert.equal(config.replies.size, 26);
  assert.equal(config.replies.lineHeight, DEFAULT_CONFIG.replies.lineHeight);
  assert.deepEqual(config.replies.font, DEFAULT_CONFIG.replies.font);
  assert.deepEqual(config.messages.color, { light: null, dark: "#abcdef" });
});

test("device font names cannot break out of the CSS string", () => {
  assert.equal(sanitizeFamily('Evil"}body{display:none'), "Evilbodydisplay:none");
  const css = buildStylesheet(
    parseConfig({ ...DEFAULT_CONFIG, replies: { ...DEFAULT_CONFIG.replies, font: { kind: "device", family: 'X";}*{color:red' } } }),
  );
  assert.ok(css.includes('font-family:"X*color:red", var(--font-sans)'));
});

test("the default stylesheet styles replies and your messages", () => {
  const css = buildStylesheet(DEFAULT_CONFIG);
  assert.ok(css.includes(`${SCOPES.replies}{`));
  assert.ok(css.includes(`${SCOPES.messages}{`));
  assert.match(css, /font-family:"Literata CT", Georgia/);
  assert.match(css, /font-size:17px;line-height:1\.65/);
  assert.match(css, /html\.dark :is\(\[data-message-column\]\.group\\\/message[^{]*\{font-weight:380\}/);
  // Theme colors stay untouched until a color is chosen.
  assert.ok(!css.includes("--foreground"));
});

test("colors apply per appearance", () => {
  const css = buildStylesheet({
    ...DEFAULT_CONFIG,
    replies: { ...DEFAULT_CONFIG.replies, color: { light: "#2b2b2b", dark: null } },
  });
  assert.ok(css.includes(`html:not(.dark) ${SCOPES.replies}{--foreground:#2b2b2b}`));
  assert.ok(!css.includes(`html.dark ${SCOPES.replies}{--foreground`));
});

test("switching the plugin off removes every rule", () => {
  assert.equal(buildStylesheet({ ...DEFAULT_CONFIG, enabled: false }), "");
});

test("the Book preset is the default look", () => {
  const book = PRESETS.find((preset) => preset.id === "book");
  assert.ok(book);
  assert.deepEqual(book.apply(DEFAULT_CONFIG), DEFAULT_CONFIG);
});

test("font faces point at the plugin route with their unicode range", () => {
  const css = buildFontFaces(
    [{ font: "literata", style: "italic", file: "literata-italic-latin.woff2", unicodeRange: "U+0000-00FF" }],
    "/fonts",
  );
  assert.equal(
    css,
    '@font-face{font-family:"Literata CT";font-style:italic;font-weight:200 900;font-display:swap;src:url("/fonts?file=literata-italic-latin.woff2") format("woff2");unicode-range:U+0000-00FF}',
  );
});
