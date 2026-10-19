// bb-plugin-chat-typography frontend.
//
// - A content script declares the bundled fonts and keeps one stylesheet in
//   sync with this device's saved config. The rules target only the markdown
//   inside chat messages, so the rest of bb keeps its own typography.
// - The settings page edits that config with a live preview.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsPage } from "./components/settings";
import { FONT_FACES } from "./font-faces";
import { loadConfig, subscribeConfig } from "./store";
import { buildFontFaces, buildStylesheet } from "./typography";

const FONT_URL = "/api/v1/plugins/chat-typography/http/font";

function mountTypography(signal: AbortSignal): () => void {
  const faces = document.createElement("style");
  faces.dataset.chatTypography = "fonts";
  faces.textContent = buildFontFaces(FONT_FACES, FONT_URL);
  const rules = document.createElement("style");
  rules.dataset.chatTypography = "rules";
  const apply = () => {
    rules.textContent = buildStylesheet(loadConfig());
  };
  apply();
  // Appended last in <head> so these rules follow bb's and its theme's.
  document.head.append(faces, rules);
  const unsubscribe = subscribeConfig(apply, signal);
  return () => {
    unsubscribe();
    faces.remove();
    rules.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "chat-typography",
    mount: ({ signal }) => mountTypography(signal),
  });
  app.slots.settingsSection({
    id: "typography",
    component: SettingsPage,
  });
});
