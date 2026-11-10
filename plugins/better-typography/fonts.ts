// The fonts this plugin ships. All four are SIL Open Font License 1.1
// variable fonts; their licenses sit beside the files in fonts/.

export type FontCategory = "serif" | "sans" | "mono";

export interface BundledFont {
  id: string;
  /** The CSS family name the content script declares. */
  family: string;
  /** What the font menu shows. */
  label: string;
  category: FontCategory;
  note: string;
  weights: { min: number; max: number };
  /** Whether the font has an `opsz` axis that `font-optical-sizing` drives. */
  opticalSizing: boolean;
}

export const BUNDLED_FONTS = [
  {
    id: "literata",
    family: "Literata",
    label: "Literata",
    category: "serif",
    note: "Book serif designed for long reading on screens",
    weights: { min: 200, max: 900 },
    opticalSizing: true,
  },
  {
    id: "source-serif-4",
    family: "Source Serif 4",
    label: "Source Serif 4",
    category: "serif",
    note: "Crisp transitional serif with optical sizes",
    weights: { min: 200, max: 900 },
    opticalSizing: true,
  },
  {
    id: "atkinson-hyperlegible-next",
    family: "Atkinson Hyperlegible Next",
    label: "Atkinson Hyperlegible Next",
    category: "sans",
    note: "Sans designed for distinguishable letterforms",
    weights: { min: 200, max: 800 },
    opticalSizing: false,
  },
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    label: "JetBrains Mono",
    category: "mono",
    note: "Tall-x-height monospace for code",
    weights: { min: 100, max: 800 },
    opticalSizing: false,
  },
] as const satisfies readonly BundledFont[];

export type BundledFontId = (typeof BUNDLED_FONTS)[number]["id"];

export function bundledFont(id: string): BundledFont | undefined {
  return BUNDLED_FONTS.find((font) => font.id === id);
}

/** Generic CSS fallback for each category. */
export const GENERIC_FAMILY: Record<FontCategory, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
