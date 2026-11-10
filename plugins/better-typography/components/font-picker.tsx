// Font menu: "same as …" and theme options, the bundled fonts, and fonts on
// this device. Each option is drawn in its own face so choosing is a matter
// of looking.
import { useId, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { deviceFontAccess, isFontInstalled, listDeviceFonts } from "../device-fonts";
import { BUNDLED_FONTS, type FontCategory } from "../fonts";
import { loadDeviceFonts, saveDeviceFonts } from "../store";
import { FieldRow } from "./fields";
import { fontLabel, fontStack, sanitizeFamily, type DerivedFontChoice, type FontChoice } from "../typography";

const DEVICE_RESULT_LIMIT = 150;

function sameChoice(a: DerivedFontChoice, b: DerivedFontChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "bundled" && b.kind === "bundled") return a.id === b.id;
  if (a.kind === "device" && b.kind === "device") return a.family.toLowerCase() === b.family.toLowerCase();
  return true;
}

function Option({
  selected,
  onSelect,
  family,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  family: string | null;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted",
        selected && "bg-muted",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-snug text-foreground" style={{ fontFamily: family ?? undefined }}>
          {title}
        </span>
        {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {selected ? <Icon name="Check" className="size-3.5 shrink-0 text-foreground" /> : null}
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:pt-1">{children}</div>;
}

const CATEGORY_ORDER: Record<FontCategory, number> = { serif: 0, sans: 1, mono: 2 };

/** A named option that stands for another font, drawn in that font. */
export interface AliasOption {
  label: string;
  detail?: string;
  family: string | null;
}

export function FontPicker({
  label,
  value,
  role,
  same,
  theme,
  onChange,
}: {
  label: string;
  value: DerivedFontChoice;
  /** Code pickers list only the monospaced bundled fonts. */
  role: "text" | "code";
  /** Offer "same as …", e.g. "Same as replies". */
  same?: AliasOption;
  /** What "theme" means here; null hides it where it would equal `same`. */
  theme: AliasOption | null;
  onChange: (value: DerivedFontChoice) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [deviceFonts, setDeviceFonts] = useState(loadDeviceFonts);
  const [scan, setScan] = useState<{ state: "idle" | "scanning" } | { state: "error"; message: string }>({ state: "idle" });
  const access = useMemo(deviceFontAccess, []);
  const needle = query.trim().toLowerCase();

  const choose = (next: DerivedFontChoice) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  const bundled = [...BUNDLED_FONTS]
    .filter((font) => (role === "code" ? font.category === "mono" : true))
    .sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category])
    .filter((font) => needle === "" || font.label.toLowerCase().includes(needle));

  const device = deviceFonts.filter((family) => needle === "" || family.toLowerCase().includes(needle));
  const typed = sanitizeFamily(query);
  const typedIsListed = deviceFonts.some((family) => family.toLowerCase() === typed.toLowerCase());
  const typedInstalled = typed !== "" && !typedIsListed && isFontInstalled(typed);

  const findFonts = async () => {
    setScan({ state: "scanning" });
    try {
      const families = await listDeviceFonts();
      saveDeviceFonts(families);
      setDeviceFonts(families);
      setScan({ state: "idle" });
    } catch (error) {
      setScan({
        state: "error",
        message:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Font access was declined. Allow it in the browser's site settings, or type a font name."
            : "Could not list this device's fonts. Type a font name instead.",
      });
    }
  };

  const generic = role === "code" ? "monospace" : "sans-serif";
  const triggerFamily =
    value.kind === "same"
      ? (same?.family ?? null)
      : value.kind === "theme"
        ? (theme?.family ?? null)
        : fontStack(value, generic);

  return (
    <FieldRow label={label} htmlFor={id}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-left shadow-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate text-[15px] text-foreground" style={{ fontFamily: triggerFamily ?? undefined }}>
              {fontLabel(value, { same: same?.label, theme: theme?.label })}
            </span>
            <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0" mobileTitle={label}>
          <div className="border-b border-border p-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={access === "available" ? "Search fonts" : "Search, or type an installed font"}
              aria-label="Search fonts"
              className="h-8"
            />
          </div>
          <div role="listbox" aria-label={label} className="max-h-80 overflow-y-auto p-1">
            {needle === "" ? (
              <>
                {same ? (
                  <Option
                    selected={value.kind === "same"}
                    onSelect={() => choose({ kind: "same" })}
                    family={same.family}
                    title={same.label}
                    detail={same.detail}
                  />
                ) : null}
                {theme ? (
                  <Option
                    selected={value.kind === "theme"}
                    onSelect={() => choose({ kind: "theme" })}
                    family={theme.family}
                    title={theme.label}
                    detail={theme.detail}
                  />
                ) : null}
              </>
            ) : null}

            {bundled.length > 0 ? <GroupLabel>Included</GroupLabel> : null}
            {bundled.map((font) => {
              const choice: FontChoice = { kind: "bundled", id: font.id };
              return (
                <Option
                  key={font.id}
                  selected={sameChoice(value, choice)}
                  onSelect={() => choose(choice)}
                  family={fontStack(choice, generic)}
                  title={font.label}
                  detail={font.note}
                />
              );
            })}

            <GroupLabel>On this device</GroupLabel>
            {device.slice(0, DEVICE_RESULT_LIMIT).map((family) => {
              const choice: FontChoice = { kind: "device", family };
              return (
                <Option
                  key={family}
                  selected={sameChoice(value, choice)}
                  onSelect={() => choose(choice)}
                  family={fontStack(choice, generic)}
                  title={family}
                />
              );
            })}
            {device.length > DEVICE_RESULT_LIMIT ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {device.length - DEVICE_RESULT_LIMIT} more — keep typing to narrow.
              </p>
            ) : null}
            {typedInstalled ? (
              <Option
                selected={false}
                onSelect={() => choose({ kind: "device", family: typed })}
                family={fontStack({ kind: "device", family: typed }, generic)}
                title={`Use “${typed}”`}
                detail="Installed on this device"
              />
            ) : typed !== "" && !typedIsListed && device.length === 0 && bundled.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">“{typed}” isn't installed on this device.</p>
            ) : null}

            {access === "available" && needle === "" ? (
              <div className="px-2 pb-2 pt-1">
                <button
                  type="button"
                  onClick={findFonts}
                  disabled={scan.state === "scanning"}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-60"
                >
                  <Icon name={scan.state === "scanning" ? "Loading" : "Laptop"} className="size-3.5" />
                  {deviceFonts.length === 0 ? "Find fonts on this device" : "Refresh device fonts"}
                </button>
                {scan.state === "error" ? <p className="mt-1.5 text-xs text-destructive">{scan.message}</p> : null}
              </div>
            ) : null}
            {access !== "available" && deviceFonts.length === 0 && needle === "" ? (
              <p className="px-2 pb-2 text-xs leading-snug text-muted-foreground">
                {access === "insecure"
                  ? "Listing fonts needs HTTPS. Type an installed font's name above."
                  : "This browser can't list fonts. Type an installed font's name above, e.g. Bookerly."}
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </FieldRow>
  );
}
