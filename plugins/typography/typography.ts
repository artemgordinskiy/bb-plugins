// The typography model: the stored config, its defaults and presets, parsing
// of untrusted stored values, and the stylesheet a config produces. Pure, so
// the content script, the settings page, and the tests share one definition.
import { BUNDLED_FONTS, bundledFont, GENERIC_FAMILY, type BundledFontId } from "./fonts.ts";

export type FontChoice =
  | { kind: "theme" }
  | { kind: "bundled"; id: BundledFontId }
  | { kind: "device"; family: string };

/** A role that can follow another role's font ("same as …"). */
export type DerivedFontChoice = FontChoice | { kind: "same" };

/** A text color per appearance; null keeps the theme's color. */
export interface ColorChoice {
  light: string | null;
  dark: string | null;
}

export interface ProseStyle {
  /** px */
  size: number;
  /** unitless multiple of the font size */
  lineHeight: number;
  weight: number;
  /** em */
  letterSpacing: number;
  color: ColorChoice;
}

export interface ChatConfig {
  enabled: boolean;
  replies: ProseStyle & { font: FontChoice };
  /**
   * Your own messages; "same" follows the replies font. `composer` sets the
   * message box in the same type, so a draft reads as it will once sent.
   */
  messages: ProseStyle & { font: DerivedFontChoice; composer: boolean };
  headings: {
    /** "same" follows the body font of each message. */
    font: DerivedFontChoice;
    weight: number;
    /** Multiplies the default heading sizes. */
    scale: number;
    /** em */
    letterSpacing: number;
    color: ColorChoice;
  };
  code: {
    /** "same" follows the app-wide code font. */
    font: DerivedFontChoice;
    /** em, relative to the surrounding text */
    size: number;
    lineHeight: number;
  };
  rhythm: {
    /** em between paragraphs, lists and quotes */
    paragraphSpacing: number;
    /** Added to body weights in dark mode, where light text reads heavier. */
    darkWeightOffset: number;
    textWrap: "pretty" | "auto";
    hyphens: boolean;
    opticalSizing: boolean;
  };
}

export interface TypographyConfig {
  enabled: boolean;
  /** bb's own UI: sidebar, menus, settings, and the message box unless chat sets it. */
  interface: {
    font: FontChoice;
    /** px for bb's base (`--text-sm`) size; null keeps the theme's scale. */
    size: number | null;
  };
  /** Monospace everywhere: code blocks, file views, diffs, the terminal. */
  code: {
    font: FontChoice;
    ligatures: boolean;
    /** "same" follows the code font, keeping bb's Nerd Font glyph fallbacks. */
    terminal: DerivedFontChoice;
  };
  chat: ChatConfig;
}

export const LIMITS = {
  interfaceSize: { min: 11, max: 17, step: 0.5 },
  size: { min: 12, max: 26, step: 0.5 },
  lineHeight: { min: 1.2, max: 2.1, step: 0.05 },
  weight: { min: 300, max: 700, step: 10 },
  letterSpacing: { min: -0.03, max: 0.06, step: 0.005 },
  headingWeight: { min: 400, max: 800, step: 10 },
  headingScale: { min: 0.85, max: 1.4, step: 0.05 },
  codeSize: { min: 0.7, max: 1.05, step: 0.01 },
  codeLineHeight: { min: 1.2, max: 2, step: 0.05 },
  paragraphSpacing: { min: 0.25, max: 1.5, step: 0.05 },
  darkWeightOffset: { min: -60, max: 20, step: 5 },
} as const;

const THEME_COLOR: ColorChoice = { light: null, dark: null };

/**
 * The interface keeps the theme's own face and scale, so installing the
 * plugin does not rearrange bb. Code everywhere moves to JetBrains Mono (the
 * terminal keeps bb's Nerd Font stack). Chat gets a book-like reading setup:
 * Literata at 17px with a 1.65 line height (about 28px), your messages one
 * pixel smaller and the message box set to match them, a slightly lighter
 * weight in dark mode, code a notch
 * smaller than the text around it, and paragraph gaps sized for the larger
 * text.
 */
export const DEFAULT_CONFIG: TypographyConfig = {
  enabled: true,
  interface: { font: { kind: "theme" }, size: null },
  code: { font: { kind: "bundled", id: "jetbrains-mono" }, ligatures: false, terminal: { kind: "theme" } },
  chat: {
    enabled: true,
    replies: {
      font: { kind: "bundled", id: "literata" },
      size: 17,
      lineHeight: 1.65,
      weight: 400,
      letterSpacing: 0,
      color: THEME_COLOR,
    },
    messages: {
      font: { kind: "same" },
      size: 16,
      lineHeight: 1.6,
      weight: 400,
      letterSpacing: 0,
      color: THEME_COLOR,
      composer: true,
    },
    headings: {
      font: { kind: "same" },
      weight: 620,
      scale: 1,
      letterSpacing: -0.01,
      color: THEME_COLOR,
    },
    code: { font: { kind: "same" }, size: 0.84, lineHeight: 1.55 },
    rhythm: {
      paragraphSpacing: 0.75,
      darkWeightOffset: -20,
      textWrap: "pretty",
      hyphens: false,
      opticalSizing: true,
    },
  },
};

export interface Preset {
  id: string;
  label: string;
  description: string;
  apply(chat: ChatConfig): ChatConfig;
}

function withProse(
  chat: ChatConfig,
  replies: Partial<ChatConfig["replies"]>,
  messages: Partial<ChatConfig["messages"]>,
  headings: Partial<ChatConfig["headings"]>,
  paragraphSpacing: number,
): ChatConfig {
  return {
    ...chat,
    enabled: true,
    replies: { ...chat.replies, ...replies },
    messages: { ...chat.messages, font: { kind: "same" }, ...messages },
    headings: { ...chat.headings, font: { kind: "same" }, ...headings },
    rhythm: { ...chat.rhythm, paragraphSpacing },
  };
}

/** Chat presets change faces, sizes and spacing; they keep your colors. */
export const PRESETS: readonly Preset[] = [
  {
    id: "book",
    label: "Book",
    description: "Literata, 17px",
    apply: (chat) =>
      withProse(
        chat,
        { font: DEFAULT_CONFIG.chat.replies.font, size: 17, lineHeight: 1.65, weight: 400, letterSpacing: 0 },
        { size: 16, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
        { weight: 620, letterSpacing: -0.01 },
        0.75,
      ),
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Source Serif 4, 17.5px",
    apply: (chat) =>
      withProse(
        chat,
        { font: { kind: "bundled", id: "source-serif-4" }, size: 17.5, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
        { size: 16.5, lineHeight: 1.55, weight: 400, letterSpacing: 0 },
        { weight: 650, letterSpacing: -0.015 },
        0.7,
      ),
  },
  {
    id: "hyperlegible",
    label: "Hyperlegible",
    description: "Atkinson Next, 16.5px",
    apply: (chat) =>
      withProse(
        chat,
        {
          font: { kind: "bundled", id: "atkinson-hyperlegible-next" },
          size: 16.5,
          lineHeight: 1.6,
          weight: 400,
          letterSpacing: 0.005,
        },
        { size: 16, lineHeight: 1.55, weight: 400, letterSpacing: 0.005 },
        { weight: 680, letterSpacing: -0.005 },
        0.7,
      ),
  },
  {
    id: "interface",
    label: "Interface font",
    description: "Interface font, 15px",
    apply: (chat) =>
      withProse(
        chat,
        { font: { kind: "theme" }, size: 15, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
        { size: 14.5, lineHeight: 1.55, weight: 400, letterSpacing: 0 },
        { weight: 600, letterSpacing: -0.01 },
        0.65,
      ),
  },
];

// ---------------------------------------------------------------------------
// Parsing stored values. localStorage is untrusted: anything malformed falls
// back to the default for that field rather than failing the whole config.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function clamp(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Device font names go into a CSS string. Keep printable characters and drop
 * anything that could end the string or the declaration.
 */
export function sanitizeFamily(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f"'\\;{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function parseColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

function parseColorChoice(value: unknown): ColorChoice {
  const input = record(value);
  return { light: parseColor(input.light), dark: parseColor(input.dark) };
}

function parseFont(value: unknown, fallback: FontChoice): FontChoice {
  if (!isRecord(value)) return fallback;
  if (value.kind === "theme") return { kind: "theme" };
  if (value.kind === "bundled" && typeof value.id === "string") {
    const font = bundledFont(value.id);
    return font === undefined ? fallback : { kind: "bundled", id: font.id as BundledFontId };
  }
  if (value.kind === "device" && typeof value.family === "string") {
    const family = sanitizeFamily(value.family);
    return family === "" ? fallback : { kind: "device", family };
  }
  return fallback;
}

function parseDerivedFont(value: unknown, fallback: DerivedFontChoice): DerivedFontChoice {
  if (!isRecord(value)) return fallback;
  if (value.kind === "same") return { kind: "same" };
  const parsed = parseFont(value, { kind: "theme" });
  // An unparseable choice keeps the default rather than becoming "theme".
  return parsed.kind === "theme" && value.kind !== "theme" ? fallback : parsed;
}

function parseProse(value: unknown, fallback: ProseStyle): ProseStyle {
  const input = record(value);
  return {
    size: clamp(input.size, LIMITS.size, fallback.size),
    lineHeight: clamp(input.lineHeight, LIMITS.lineHeight, fallback.lineHeight),
    weight: clamp(input.weight, LIMITS.weight, fallback.weight),
    letterSpacing: clamp(input.letterSpacing, LIMITS.letterSpacing, fallback.letterSpacing),
    color: parseColorChoice(input.color),
  };
}

function parseChat(value: unknown): ChatConfig {
  const input = record(value);
  const d = DEFAULT_CONFIG.chat;
  const replies = record(input.replies);
  const messages = record(input.messages);
  const headings = record(input.headings);
  const code = record(input.code);
  const rhythm = record(input.rhythm);
  return {
    enabled: bool(input.enabled, d.enabled),
    replies: { ...parseProse(replies, d.replies), font: parseFont(replies.font, d.replies.font) },
    messages: {
      ...parseProse(messages, d.messages),
      font: parseDerivedFont(messages.font, d.messages.font),
      composer: bool(messages.composer, d.messages.composer),
    },
    headings: {
      font: parseDerivedFont(headings.font, d.headings.font),
      weight: clamp(headings.weight, LIMITS.headingWeight, d.headings.weight),
      scale: clamp(headings.scale, LIMITS.headingScale, d.headings.scale),
      letterSpacing: clamp(headings.letterSpacing, LIMITS.letterSpacing, d.headings.letterSpacing),
      color: parseColorChoice(headings.color),
    },
    code: {
      font: parseDerivedFont(code.font, d.code.font),
      size: clamp(code.size, LIMITS.codeSize, d.code.size),
      lineHeight: clamp(code.lineHeight, LIMITS.codeLineHeight, d.code.lineHeight),
    },
    rhythm: {
      paragraphSpacing: clamp(rhythm.paragraphSpacing, LIMITS.paragraphSpacing, d.rhythm.paragraphSpacing),
      darkWeightOffset: clamp(rhythm.darkWeightOffset, LIMITS.darkWeightOffset, d.rhythm.darkWeightOffset),
      textWrap: rhythm.textWrap === "auto" ? "auto" : "pretty",
      hyphens: bool(rhythm.hyphens, d.rhythm.hyphens),
      opticalSizing: bool(rhythm.opticalSizing, d.rhythm.opticalSizing),
    },
  };
}

export function parseConfig(value: unknown): TypographyConfig {
  const input = record(value);
  const d = DEFAULT_CONFIG;
  const ui = record(input.interface);
  const code = record(input.code);
  return {
    enabled: bool(input.enabled, d.enabled),
    interface: {
      font: parseFont(ui.font, d.interface.font),
      size: typeof ui.size === "number" ? clamp(ui.size, LIMITS.interfaceSize, 13) : null,
    },
    code: {
      font: parseFont(code.font, d.code.font),
      ligatures: bool(code.ligatures, d.code.ligatures),
      terminal: parseDerivedFont(code.terminal, d.code.terminal),
    },
    chat: parseChat(input.chat),
  };
}

// ---------------------------------------------------------------------------
// Theme values

export const TEXT_TOKENS = [
  "--text-2xs",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
] as const;

export type TextToken = (typeof TEXT_TOKENS)[number];

/**
 * The theme's own font stacks and size scale, read from the page before this
 * plugin's rules apply. Overrides fall back to these literal values: a rule
 * like `--font-sans: "X", var(--font-sans)` would reference itself.
 */
export interface ThemeTokens {
  fontSans: string;
  fontMono: string;
  fontTerminal: string;
  /** px */
  text: Partial<Record<TextToken, number>>;
}

/** bb 0.46's defaults, for when the page cannot be read. */
export const BB_THEME: ThemeTokens = {
  fontSans: '"Inter Variable", Inter, sans-serif',
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontTerminal:
    '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  text: {
    "--text-2xs": 10,
    "--text-xs": 12,
    "--text-sm": 13,
    "--text-base": 15,
    "--text-lg": 18,
    "--text-xl": 20,
    "--text-2xl": 24,
  },
};

/** The theme's base interface size in px. */
export function themeBaseSize(theme: ThemeTokens): number {
  return theme.text["--text-sm"] ?? 13;
}

// ---------------------------------------------------------------------------
// Stylesheet

/**
 * bb renders every chat message's markdown in `[data-markdown-preview]`
 * inside a `[data-message-column]`; the assistant's column carries the
 * `group/message` class and the user's bubble column does not. The settings
 * preview marks its samples with `data-typography-sample`. The message box
 * is a ProseMirror editor inside `[data-promptbox-editor-content]`, on the
 * new-thread page and under every thread.
 */
export const SCOPES = {
  replies:
    ':is([data-message-column].group\\/message, [data-typography-sample="replies"]) [data-markdown-preview]',
  messages:
    ':is([data-message-column]:not(.group\\/message), [data-typography-sample="messages"]) [data-markdown-preview]',
  composer: ':is([data-promptbox-editor-content] .ProseMirror, [data-typography-sample="composer"])',
} as const;

/** The font-family value for a choice, or null to keep the theme's. */
export function fontStack(choice: FontChoice, fallback: string): string | null {
  switch (choice.kind) {
    case "theme":
      return null;
    case "bundled": {
      const font = bundledFont(choice.id);
      return font === undefined ? null : `"${font.family}", ${GENERIC_FAMILY[font.category]}`;
    }
    case "device":
      return `"${sanitizeFamily(choice.family)}", ${fallback}`;
  }
}

/** The face a choice draws first; null for the theme's. */
export function primaryFamily(choice: FontChoice): string | null {
  switch (choice.kind) {
    case "theme":
      return null;
    case "bundled":
      return bundledFont(choice.id)?.family ?? null;
    case "device":
      return sanitizeFamily(choice.family);
  }
}

export function resolveFont(choice: DerivedFontChoice, parent: FontChoice): FontChoice {
  return choice.kind === "same" ? parent : choice;
}

function num(value: number, digits = 4): string {
  return Number(value.toFixed(digits)).toString();
}

function rule(selector: string, declarations: Record<string, string | null>): string {
  const body = Object.entries(declarations)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
  return body === "" ? "" : `${selector}{${body}}`;
}

function colorRules(scope: string, color: ColorChoice, property = "--foreground"): string[] {
  return [
    color.light === null ? "" : rule(`html:not(.dark) ${scope}`, { [property]: color.light }),
    color.dark === null ? "" : rule(`html.dark ${scope}`, { [property]: color.dark }),
  ];
}

// `html:root` outranks the theme's `:root` token rules without !important.
const ROOT = "html:root";

function rootRules(config: TypographyConfig, theme: ThemeTokens): string[] {
  const { interface: ui, code } = config;
  const declarations: Record<string, string | null> = {
    "--font-sans": fontStack(ui.font, theme.fontSans),
  };
  const codeStack = fontStack(code.font, theme.fontMono);
  declarations["--font-mono"] = codeStack;
  // Diffs and the source viewer draw in shadow DOM from their own variable.
  declarations["--diffs-font-family"] = codeStack;
  const terminalFamily = primaryFamily(resolveFont(code.terminal, code.font));
  // Keep bb's stack behind the choice so Nerd Font glyphs still render.
  declarations["--font-terminal"] = terminalFamily === null ? null : `"${terminalFamily}", ${theme.fontTerminal}`;
  if (!code.ligatures) declarations["--diffs-font-features"] = '"liga" 0, "calt" 0';

  if (ui.size !== null) {
    const scale = ui.size / themeBaseSize(theme);
    for (const token of TEXT_TOKENS) {
      const value = theme.text[token];
      if (value !== undefined) declarations[token] = `${num(value * scale, 3)}px`;
    }
  }
  return [
    rule(ROOT, declarations),
    code.ligatures
      ? ""
      : rule(':is(code, pre, kbd, samp, .font-mono, [class*="font-mono"])', {
          "font-variant-ligatures": "none",
        }),
  ];
}

function darkWeight(style: ProseStyle, rhythm: ChatConfig["rhythm"]): string {
  return String(Math.min(900, Math.max(100, style.weight + rhythm.darkWeightOffset)));
}

function proseRules(scope: string, style: ProseStyle, font: FontChoice, config: TypographyConfig): string[] {
  const { rhythm, headings, code } = config.chat;
  const headingFont = resolveFont(headings.font, font);
  const codeFont = resolveFont(code.font, config.code.font);
  const h = (base: number) => `${num(base * headings.scale)}em`;
  return [
    rule(scope, {
      // Sizes inside the markdown (inline code, small labels) follow the text
      // instead of bb's fixed interface scale.
      "--text-xs": "0.84em",
      "--text-sm": "1em",
      "--text-base": "1.08em",
      "--text-lg": "1.25em",
      "--typography-gap": `${num(rhythm.paragraphSpacing)}em`,
      "font-family": fontStack(font, "var(--font-sans)"),
      "font-size": `${num(style.size)}px`,
      "line-height": num(style.lineHeight),
      "font-weight": String(style.weight),
      "letter-spacing": `${num(style.letterSpacing)}em`,
      "font-optical-sizing": rhythm.opticalSizing ? "auto" : "none",
      "text-wrap-style": rhythm.textWrap,
      hyphens: rhythm.hyphens ? "auto" : "manual",
      "text-rendering": "optimizeLegibility",
    }),
    rule(`html.dark ${scope}`, { "font-weight": darkWeight(style, rhythm) }),
    ...colorRules(scope, style.color),
    rule(`${scope} :is(p, ul, ol, blockquote, table):not(:last-child)`, {
      "margin-bottom": "var(--typography-gap)",
    }),
    rule(`${scope} li:not(:last-child)`, { "margin-bottom": "calc(var(--typography-gap) * 0.4)" }),
    rule(`${scope} :is(h1, h2, h3, h4, h5, h6)`, {
      "font-family": fontStack(headingFont, "var(--font-sans)"),
      "font-weight": String(headings.weight),
      "letter-spacing": `${num(headings.letterSpacing)}em`,
      "line-height": "1.3",
      "text-wrap-style": "balance",
      "margin-bottom": "0.45em",
    }),
    rule(`${scope} :is(h1, h2, h3, h4, h5, h6):not(:first-child)`, { "margin-top": "1.35em" }),
    rule(`${scope} h1`, { "font-size": h(1.45) }),
    rule(`${scope} h2`, { "font-size": h(1.25) }),
    rule(`${scope} h3`, { "font-size": h(1.1) }),
    rule(`${scope} h4`, { "font-size": h(1) }),
    rule(`${scope} :is(h5, h6)`, { "font-size": "0.82em", "letter-spacing": "0.04em" }),
    ...colorRules(`${scope} :is(h1, h2, h3, h4)`, headings.color, "color"),
    // !important so another plugin's global code rule cannot resize chat code.
    rule(`${scope} :is(code, kbd, samp)`, {
      "font-family": `${fontStack(codeFont, "var(--font-mono)") ?? "var(--font-mono)"} !important`,
      "font-size": `${num(code.size)}em !important`,
      "letter-spacing": "0",
    }),
    rule(`${scope} pre`, { "line-height": num(code.lineHeight) }),
    rule(`${scope} pre code`, { "line-height": "inherit" }),
  ];
}

/**
 * The message box in your messages' type. Colors and paragraph rhythm stay
 * bb's, and wrapping stays plain so earlier lines do not reflow while typing.
 */
function composerRules(style: ProseStyle, font: FontChoice, rhythm: ChatConfig["rhythm"]): string[] {
  return [
    rule(SCOPES.composer, {
      "font-family": fontStack(font, "var(--font-sans)"),
      "font-size": `${num(style.size)}px`,
      "line-height": num(style.lineHeight),
      "font-weight": String(style.weight),
      "letter-spacing": `${num(style.letterSpacing)}em`,
      "font-optical-sizing": rhythm.opticalSizing ? "auto" : "none",
    }),
    rule(`html.dark ${SCOPES.composer}`, { "font-weight": darkWeight(style, rhythm) }),
  ];
}

/** The stylesheet for a config; empty when the plugin is switched off. */
export function buildStylesheet(config: TypographyConfig, theme: ThemeTokens = BB_THEME): string {
  if (!config.enabled) return "";
  const chat = config.chat;
  const messagesFont = resolveFont(chat.messages.font, chat.replies.font);
  return [
    ...rootRules(config, theme),
    ...(chat.enabled
      ? [
          ...proseRules(SCOPES.replies, chat.replies, chat.replies.font, config),
          ...proseRules(SCOPES.messages, chat.messages, messagesFont, config),
          ...(chat.messages.composer ? composerRules(chat.messages, messagesFont, chat.rhythm) : []),
        ]
      : []),
  ]
    .filter((text) => text !== "")
    .join("\n");
}

/** `@font-face` rules for every bundled face, served by this plugin's backend. */
export function buildFontFaces(
  faces: readonly { font: string; style: string; file: string; unicodeRange: string }[],
  baseUrl: string,
): string {
  return faces
    .map((face) => {
      const font = bundledFont(face.font);
      if (font === undefined) return "";
      return `@font-face{font-family:"${font.family}";font-style:${face.style};font-weight:${font.weights.min} ${font.weights.max};font-display:swap;src:url("${baseUrl}?file=${face.file}") format("woff2");unicode-range:${face.unicodeRange}}`;
    })
    .filter((text) => text !== "")
    .join("\n");
}

export function fontLabel(choice: DerivedFontChoice, labels: { same?: string; theme?: string } = {}): string {
  switch (choice.kind) {
    case "same":
      return labels.same ?? "Same";
    case "theme":
      return labels.theme ?? "Theme font";
    case "bundled":
      return bundledFont(choice.id)?.label ?? choice.id;
    case "device":
      return choice.family;
  }
}

export { BUNDLED_FONTS };
