// Fonts installed on the device viewing bb. Chromium browsers (and the
// desktop app) can list them through the Local Font Access API after a
// permission prompt; everywhere else a typed name is checked by measuring.
import { sanitizeFamily } from "./typography";

interface LocalFontData {
  family: string;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

export type DeviceFontAccess = "available" | "unsupported" | "insecure";

export function deviceFontAccess(): DeviceFontAccess {
  if (!window.isSecureContext) return "insecure";
  return typeof Reflect.get(window, "queryLocalFonts") === "function" ? "available" : "unsupported";
}

/** Sorted, de-duplicated family names; prompts for permission on first use. */
export async function listDeviceFonts(): Promise<string[]> {
  const query = Reflect.get(window, "queryLocalFonts") as QueryLocalFonts;
  const fonts = await query.call(window);
  const families = new Map<string, string>();
  for (const { family } of fonts) {
    const clean = sanitizeFamily(family);
    // Names starting with "." are private system faces (e.g. ".SF NS").
    if (clean === "" || clean.startsWith(".")) continue;
    families.set(clean.toLocaleLowerCase(), clean);
  }
  return [...families.values()].sort((a, b) => a.localeCompare(b));
}

let canvas: HTMLCanvasElement | null = null;

/**
 * Whether `family` renders differently from a generic fallback, i.e. is
 * installed. `document.fonts.check` cannot tell: it reports true for unknown
 * local names because nothing needs downloading.
 */
export function isFontInstalled(family: string): boolean {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return false;
  const sample = "mmmmmmmmmmlli1WQ@#&Яж";
  const name = sanitizeFamily(family);
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    context.font = `72px ${generic}`;
    const base = context.measureText(sample).width;
    context.font = `72px "${name}", ${generic}`;
    return context.measureText(sample).width !== base;
  });
}
