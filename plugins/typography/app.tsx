// bb-plugin-typography frontend.
//
// - A content script declares the bundled fonts and keeps one stylesheet in
//   sync with this device's saved config and the current theme: interface
//   and code fonts through bb's root tokens, reading typography inside chat
//   messages through scoped rules.
// - The settings page edits that config with live previews.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsPage } from "./components/settings";
import { bundledFont } from "./fonts";
import { FONT_FACES } from "./font-faces";
import { loadConfig, subscribeConfig } from "./store";
import { observeTheme, readThemeTokens } from "./theme";
import { buildFontFaces, buildStylesheet, resolveFont, type TypographyConfig } from "./typography";

const FONT_URL = "/api/v1/plugins/typography/http/font";

/**
 * The terminal measures its font once when it opens, so a bundled terminal
 * font has to be loaded before then rather than on first use.
 */
function preloadTerminalFont(config: TypographyConfig): void {
  const choice = resolveFont(config.code.terminal, config.code.font);
  const font = choice.kind === "bundled" ? bundledFont(choice.id) : undefined;
  if (config.enabled && font !== undefined) {
    void document.fonts.load(`12px "${font.family}"`).catch(() => undefined);
  }
}

function mountTypography(signal: AbortSignal): () => void {
  const faces = document.createElement("style");
  faces.dataset.typography = "fonts";
  faces.textContent = buildFontFaces(FONT_FACES, FONT_URL);
  const rules = document.createElement("style");
  rules.dataset.typography = "rules";
  // Appended last in <head> so these rules follow bb's and its theme's.
  document.head.append(faces, rules);

  let theme = readThemeTokens();
  const apply = () => {
    const config = loadConfig();
    const next = buildStylesheet(config, theme);
    if (rules.textContent !== next) rules.textContent = next;
    preloadTerminalFont(config);
  };
  apply();
  const unsubscribe = subscribeConfig(apply, signal);
  const unobserve = observeTheme(() => {
    theme = readThemeTokens();
    apply();
  }, signal);
  return () => {
    unsubscribe();
    unobserve();
    faces.remove();
    rules.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "typography",
    mount: ({ signal }) => mountTypography(signal),
  });
  app.slots.settingsSection({
    id: "typography",
    component: SettingsPage,
  });
});
