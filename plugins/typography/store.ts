// Per-device persistence. Typography is a property of the screen you read
// on, so settings live in this browser's localStorage, like the Fonts
// plugin's, and every open bb tab follows a change.
import { useEffect, useState } from "react";
import { DEFAULT_CONFIG, parseConfig, sanitizeFamily, type TypographyConfig } from "./typography";

const CONFIG_KEY = "bb-plugin-typography:config:v1";
const DEVICE_FONTS_KEY = "bb-plugin-typography:device-fonts:v1";
const CHANGE_EVENT = "bb-plugin-typography:change";

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadConfig(): TypographyConfig {
  const stored = read(CONFIG_KEY);
  return stored === null ? DEFAULT_CONFIG : parseConfig(stored);
}

export function saveConfig(config: TypographyConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(parseConfig(config)));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Calls `listener` when this tab or another tab saves a config. */
export function subscribeConfig(listener: () => void, signal?: AbortSignal): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONFIG_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener, { signal });
  window.addEventListener("storage", onStorage, { signal });
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useConfig(): [TypographyConfig, (next: TypographyConfig) => void] {
  const [config, setConfig] = useState(loadConfig);
  useEffect(() => subscribeConfig(() => setConfig(loadConfig())), []);
  return [config, saveConfig];
}

/** Font family names found on this device, remembered between visits. */
export function loadDeviceFonts(): string[] {
  const stored = read(DEVICE_FONTS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is string => typeof item === "string").map(sanitizeFamily).filter(Boolean);
}

export function saveDeviceFonts(families: readonly string[]): void {
  localStorage.setItem(DEVICE_FONTS_KEY, JSON.stringify(families));
}
