// Reading the page's own typography tokens: the theme's font stacks and text
// scale as they are without this plugin, and whether something else on the
// page overrides what this plugin sets.
import { useEffect, useState } from "react";
import { BB_THEME, TEXT_TOKENS, fontStack, type ThemeTokens, type TypographyConfig } from "./typography";

/** The `<style>` element holding this plugin's rules. */
export const RULES_SELECTOR = 'style[data-typography="rules"]';

function toPx(value: string, rootSize: number): number | undefined {
  const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === "rem" ? amount * rootSize : amount;
}

/** The theme's tokens, read with this plugin's rules switched off for a moment. */
export function readThemeTokens(): ThemeTokens {
  const rules = document.querySelector<HTMLStyleElement>(RULES_SELECTOR);
  const wasDisabled = rules?.disabled ?? true;
  if (rules) rules.disabled = true;
  try {
    const style = getComputedStyle(document.documentElement);
    const rootSize = Number.parseFloat(style.fontSize) || 16;
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const text: ThemeTokens["text"] = {};
    for (const token of TEXT_TOKENS) {
      const px = toPx(style.getPropertyValue(token), rootSize);
      if (px !== undefined) text[token] = px;
    }
    return {
      fontSans: read("--font-sans", BB_THEME.fontSans),
      fontMono: read("--font-mono", BB_THEME.fontMono),
      fontTerminal: read("--font-terminal", BB_THEME.fontTerminal),
      text: Object.keys(text).length > 0 ? text : BB_THEME.text,
    };
  } finally {
    if (rules) rules.disabled = wasDisabled;
  }
}

/** Theme changes arrive as <html> class or style changes, or new stylesheets. */
export function observeTheme(listener: () => void, signal?: AbortSignal): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.head, { childList: true });
  const coarse = window.matchMedia("(pointer: coarse)");
  coarse.addEventListener("change", listener, { signal });
  const stop = () => {
    observer.disconnect();
    coarse.removeEventListener("change", listener);
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

export function useThemeTokens(): ThemeTokens {
  const [theme, setTheme] = useState(readThemeTokens);
  useEffect(() => observeTheme(() => setTheme(readThemeTokens())), []);
  return theme;
}

const normalize = (value: string) => value.replace(/["'\s]/g, "").toLowerCase();

/**
 * The root font tokens this config sets that the page ends up not using,
 * because another plugin or theme declares them with higher priority (the
 * Fonts plugin uses `!important`).
 */
export function overriddenTokens(config: TypographyConfig, theme: ThemeTokens): string[] {
  if (!config.enabled) return [];
  const style = getComputedStyle(document.documentElement);
  const expected: [string, string | null][] = [
    ["--font-sans", fontStack(config.interface.font, theme.fontSans)],
    ["--font-mono", fontStack(config.code.font, theme.fontMono)],
  ];
  return expected
    .filter(([name, value]) => value !== null && normalize(style.getPropertyValue(name)) !== normalize(value))
    .map(([name]) => name);
}
