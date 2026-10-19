// Resolving theme colors (often oklch) to sRGB for contrast checks.
import { useEffect, useState } from "react";

export type Appearance = "light" | "dark";

function currentAppearance(): Appearance {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Follows bb's `dark` class on <html>. */
export function useAppearance(): Appearance {
  const [appearance, setAppearance] = useState(currentAppearance);
  useEffect(() => {
    const observer = new MutationObserver(() => setAppearance(currentAppearance()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return appearance;
}

let context: CanvasRenderingContext2D | null = null;

/** Any CSS color to [r, g, b] in 0..255, by painting one canvas pixel. */
function toRgb(color: string): [number, number, number] | null {
  context ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "#000";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return r === undefined || g === undefined || b === undefined ? null : [r, g, b];
}

export function toHex(color: string): string | null {
  const rgb = toRgb(color);
  return rgb === null ? null : `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio between two CSS colors. */
export function contrastRatio(foreground: string, background: string): number {
  const a = toRgb(foreground);
  const b = toRgb(background);
  if (a === null || b === null) return 1;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The current value of a theme color variable, as hex. */
export function useSurfaceColor(variable: string, appearance: Appearance): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    const probe = document.createElement("span");
    probe.style.cssText = `position:fixed;visibility:hidden;color:var(${variable})`;
    document.body.appendChild(probe);
    setColor(toHex(getComputedStyle(probe).color));
    probe.remove();
  }, [variable, appearance]);
  return color;
}
