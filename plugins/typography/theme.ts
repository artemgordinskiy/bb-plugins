// Reading the page's own typography tokens: the theme's font stacks and text
// scale as they are without this plugin, and whether something else on the
// page overrides what this plugin sets.
import { useEffect, useState } from "react";
import { fontStack, type ThemeTokens, type TypographyConfig } from "./typography";
import { observeTheme, readThemeTokens } from "./theme-dom";
export { RULES_SELECTOR, observeTheme, readThemeTokens } from "./theme-dom";

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
