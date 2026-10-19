// The typography model: the stored config, its defaults and presets, parsing
// of untrusted stored values, and the stylesheet a config produces. Pure, so
// the content script, the settings page, and the tests share one definition.
import { BUNDLED_FONTS, bundledFont, GENERIC_FAMILY, type BundledFontId } from "./fonts.ts";

export type FontChoice =
  | { kind: "theme" }
  | { kind: "bundled"; id: BundledFontId }
  | { kind: "device"; family: string };

/** Headings, your messages and code can follow another role's font. */
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

export interface TypographyConfig {
  enabled: boolean;
  replies: ProseStyle & { font: FontChoice };
  /** Your own messages; "same" follows the replies font. */
  messages: ProseStyle & { font: DerivedFontChoice };
  headings: {
    font: DerivedFontChoice;
    weight: number;
    /** Multiplies the default heading sizes. */
    scale: number;
    /** em */
    letterSpacing: number;
    color: ColorChoice;
  };
  code: {
    font: FontChoice;
    /** em, relative to the surrounding text */
    size: number;
    lineHeight: number;
    ligatures: boolean;
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

export const LIMITS = {
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
 * The defaults are a book-like reading setup: Literata at 17px with a 1.65
 * line height (about 28px), a slightly lighter weight in dark mode, code a
 * notch smaller in JetBrains Mono, and paragraph gaps sized for the larger
 * text. Your messages keep the same face one pixel smaller so replies stay
 * the primary reading surface.
 */
export const DEFAULT_CONFIG: TypographyConfig = {
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
  },
  headings: {
    font: { kind: "same" },
    weight: 620,
    scale: 1,
    letterSpacing: -0.01,
    color: THEME_COLOR,
  },
  code: {
    font: { kind: "bundled", id: "jetbrains-mono" },
    size: 0.84,
    lineHeight: 1.55,
    ligatures: false,
  },
  rhythm: {
    paragraphSpacing: 0.75,
    darkWeightOffset: -20,
    textWrap: "pretty",
    hyphens: false,
    opticalSizing: true,
  },
};

export interface Preset {
  id: string;
  label: string;
  description: string;
  apply(config: TypographyConfig): TypographyConfig;
}

function withProse(
  config: TypographyConfig,
  replies: Partial<TypographyConfig["replies"]>,
  messages: Partial<TypographyConfig["messages"]>,
): TypographyConfig {
  return {
    ...config,
    enabled: true,
    replies: { ...config.replies, ...replies },
    messages: { ...config.messages, ...messages },
  };
}

/** Presets change faces, sizes and spacing; they keep your colors. */
export const PRESETS: readonly Preset[] = [
  {
    id: "book",
    label: "Book",
    description: "Literata, 17px",
    apply: (config) => ({
      ...withProse(
        config,
        { font: DEFAULT_CONFIG.replies.font, size: 17, lineHeight: 1.65, weight: 400, letterSpacing: 0 },
        { font: { kind: "same" }, size: 16, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
      ),
      headings: { ...config.headings, font: { kind: "same" }, weight: 620, letterSpacing: -0.01 },
      rhythm: { ...config.rhythm, paragraphSpacing: 0.75 },
    }),
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Source Serif 4, 17.5px",
    apply: (config) => ({
      ...withProse(
        config,
        { font: { kind: "bundled", id: "source-serif-4" }, size: 17.5, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
        { font: { kind: "same" }, size: 16.5, lineHeight: 1.55, weight: 400, letterSpacing: 0 },
      ),
      headings: { ...config.headings, font: { kind: "same" }, weight: 650, letterSpacing: -0.015 },
      rhythm: { ...config.rhythm, paragraphSpacing: 0.7 },
    }),
  },
  {
    id: "hyperlegible",
    label: "Hyperlegible",
    description: "Atkinson Next, 16.5px",
    apply: (config) => ({
      ...withProse(
        config,
        { font: { kind: "bundled", id: "atkinson-hyperlegible-next" }, size: 16.5, lineHeight: 1.6, weight: 400, letterSpacing: 0.005 },
        { font: { kind: "same" }, size: 16, lineHeight: 1.55, weight: 400, letterSpacing: 0.005 },
      ),
      headings: { ...config.headings, font: { kind: "same" }, weight: 680, letterSpacing: -0.005 },
      rhythm: { ...config.rhythm, paragraphSpacing: 0.7 },
    }),
  },
  {
    id: "theme",
    label: "Theme fonts",
    description: "bb's faces, larger",
    apply: (config) => ({
      ...withProse(
        config,
        { font: { kind: "theme" }, size: 15, lineHeight: 1.6, weight: 400, letterSpacing: 0 },
        { font: { kind: "same" }, size: 14.5, lineHeight: 1.55, weight: 400, letterSpacing: 0 },
      ),
      headings: { ...config.headings, font: { kind: "same" }, weight: 600, letterSpacing: -0.01 },
      code: { ...config.code, font: { kind: "theme" } },
      rhythm: { ...config.rhythm, paragraphSpacing: 0.65 },
    }),
  },
];

// ---------------------------------------------------------------------------
// Parsing stored values. localStorage is untrusted: anything malformed falls
// back to the default for that field rather than failing the whole config.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(value)) return THEME_COLOR;
  return { light: parseColor(value.light), dark: parseColor(value.dark) };
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
  const input = isRecord(value) ? value : {};
  return {
    size: clamp(input.size, LIMITS.size, fallback.size),
    lineHeight: clamp(input.lineHeight, LIMITS.lineHeight, fallback.lineHeight),
    weight: clamp(input.weight, LIMITS.weight, fallback.weight),
    letterSpacing: clamp(input.letterSpacing, LIMITS.letterSpacing, fallback.letterSpacing),
    color: parseColorChoice(input.color),
  };
}

export function parseConfig(value: unknown): TypographyConfig {
  const input = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG;
  const replies = isRecord(input.replies) ? input.replies : {};
  const messages = isRecord(input.messages) ? input.messages : {};
  const headings = isRecord(input.headings) ? input.headings : {};
  const code = isRecord(input.code) ? input.code : {};
  const rhythm = isRecord(input.rhythm) ? input.rhythm : {};
  return {
    enabled: bool(input.enabled, d.enabled),
    replies: { ...parseProse(replies, d.replies), font: parseFont(replies.font, d.replies.font) },
    messages: {
      ...parseProse(messages, d.messages),
      font: parseDerivedFont(messages.font, d.messages.font),
    },
    headings: {
      font: parseDerivedFont(headings.font, d.headings.font),
      weight: clamp(headings.weight, LIMITS.headingWeight, d.headings.weight),
      scale: clamp(headings.scale, LIMITS.headingScale, d.headings.scale),
      letterSpacing: clamp(headings.letterSpacing, LIMITS.letterSpacing, d.headings.letterSpacing),
      color: parseColorChoice(headings.color),
    },
    code: {
      font: parseFont(code.font, d.code.font),
      size: clamp(code.size, LIMITS.codeSize, d.code.size),
      lineHeight: clamp(code.lineHeight, LIMITS.codeLineHeight, d.code.lineHeight),
      ligatures: bool(code.ligatures, d.code.ligatures),
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

// ---------------------------------------------------------------------------
// Stylesheet

/**
 * bb renders every chat message's markdown in `[data-markdown-preview]`
 * inside a `[data-message-column]`; the assistant's column carries the
 * `group/message` class and the user's bubble column does not. The settings
 * preview marks its samples with `data-chat-typography-sample`.
 */
export const SCOPES = {
  replies:
    ':is([data-message-column].group\\/message, [data-chat-typography-sample="replies"]) [data-markdown-preview]',
  messages:
    ':is([data-message-column]:not(.group\\/message), [data-chat-typography-sample="messages"]) [data-markdown-preview]',
} as const;

export function fontStack(choice: FontChoice, role: "prose" | "code"): string | null {
  const themeVar = role === "code" ? "var(--font-mono)" : "var(--font-sans)";
  switch (choice.kind) {
    case "theme":
      return null;
    case "bundled": {
      const font = bundledFont(choice.id);
      if (font === undefined) return null;
      return `"${font.family}", ${GENERIC_FAMILY[font.category]}`;
    }
    case "device":
      return `"${sanitizeFamily(choice.family)}", ${themeVar}`;
  }
}

function resolve(choice: DerivedFontChoice, parent: FontChoice): FontChoice {
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

function proseRules(scope: string, style: ProseStyle, font: FontChoice, config: TypographyConfig): string[] {
  const { rhythm, headings, code } = config;
  const headingFont = resolve(headings.font, font);
  const codeFont = code.font;
  const darkWeight = Math.min(900, Math.max(100, style.weight + rhythm.darkWeightOffset));
  const h = (base: number) => `${num(base * headings.scale)}em`;
  return [
    rule(scope, {
      // Sizes inside the markdown (inline code, small labels) follow the text
      // instead of bb's fixed 12-18px scale.
      "--text-xs": "0.84em",
      "--text-sm": "1em",
      "--text-base": "1.08em",
      "--text-lg": "1.25em",
      "--chat-typography-gap": `${num(rhythm.paragraphSpacing)}em`,
      "font-family": fontStack(font, "prose"),
      "font-size": `${num(style.size)}px`,
      "line-height": num(style.lineHeight),
      "font-weight": String(style.weight),
      "letter-spacing": `${num(style.letterSpacing)}em`,
      "font-optical-sizing": rhythm.opticalSizing ? "auto" : "none",
      "text-wrap-style": rhythm.textWrap,
      hyphens: rhythm.hyphens ? "auto" : "manual",
      "text-rendering": "optimizeLegibility",
    }),
    rule(`html.dark ${scope}`, { "font-weight": String(darkWeight) }),
    ...colorRules(scope, style.color),
    rule(`${scope} :is(p, ul, ol, blockquote, table):not(:last-child)`, {
      "margin-bottom": "var(--chat-typography-gap)",
    }),
    rule(`${scope} li:not(:last-child)`, { "margin-bottom": "calc(var(--chat-typography-gap) * 0.4)" }),
    rule(`${scope} :is(h1, h2, h3, h4, h5, h6)`, {
      "font-family": fontStack(headingFont, "prose"),
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
    // !important so the Fonts plugin's global code rule cannot resize chat code.
    rule(`${scope} :is(code, kbd, samp)`, {
      "font-family": `${fontStack(codeFont, "code") ?? "var(--font-mono)"} !important`,
      "font-size": `${num(code.size)}em !important`,
      "letter-spacing": "0",
      "font-variant-ligatures": code.ligatures ? "normal" : "none",
      "font-feature-settings": code.ligatures ? "normal" : '"liga" 0, "calt" 0',
    }),
    rule(`${scope} pre`, { "line-height": num(code.lineHeight) }),
    rule(`${scope} pre code`, { "line-height": "inherit" }),
  ].filter((text) => text !== "");
}

/** The stylesheet for a config; empty when the plugin is switched off. */
export function buildStylesheet(config: TypographyConfig): string {
  if (!config.enabled) return "";
  const messagesFont = resolve(config.messages.font, config.replies.font);
  return [
    ...proseRules(SCOPES.replies, config.replies, config.replies.font, config),
    ...proseRules(SCOPES.messages, config.messages, messagesFont, config),
  ].join("\n");
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

export function fontLabel(choice: DerivedFontChoice, sameLabel = "Same as replies"): string {
  switch (choice.kind) {
    case "same":
      return sameLabel;
    case "theme":
      return "Theme font";
    case "bundled":
      return bundledFont(choice.id)?.label ?? choice.id;
    case "device":
      return choice.family;
  }
}

export { BUNDLED_FONTS };
