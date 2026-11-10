// Labeled controls for the settings page. Each field shows its current
// value and a reset button once it differs from the default.
import { useId, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { contrastRatio, useAppearance, useSurfaceColor } from "../color";
import type { ColorChoice } from "../typography";

export function FieldRow({
  label,
  htmlFor,
  value,
  onReset,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  value?: ReactNode;
  onReset?: (() => void) | null;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex min-h-5 items-center gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Reset ${label.toLowerCase()}`}
            title="Reset to default"
          >
            <Icon name="RotateCcw" className="size-3" />
          </button>
        ) : null}
        {value === undefined ? null : (
          <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
        )}
      </div>
      {children}
      {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SliderField({
  label,
  value,
  defaultValue,
  limits,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  defaultValue: number;
  limits: { min: number; max: number; step: number };
  format: (value: number) => string;
  onChange: (value: number) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <FieldRow
      label={label}
      htmlFor={id}
      value={format(value)}
      onReset={value === defaultValue ? null : () => onChange(defaultValue)}
      hint={hint}
    >
      <Slider
        id={id}
        aria-label={label}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(Number(next.toFixed(4)));
        }}
        className="py-1"
      />
    </FieldRow>
  );
}

export function SwitchField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {description ? <p className="text-xs leading-snug text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} size="default" checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

/** WCAG AA asks 4.5:1 for body text; AAA asks 7:1. */
function ContrastBadge({ ratio }: { ratio: number }) {
  const grade = ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "Low";
  return (
    <span
      className={cn(
        "rounded px-1 font-mono text-[10px] tabular-nums",
        grade === "Low" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
      )}
      title="Contrast against the message background (WCAG: 4.5 AA, 7 AAA)"
    >
      {ratio.toFixed(1)} {grade}
    </span>
  );
}

function Swatch({
  mode,
  value,
  themeColor,
  surface,
  active,
  onChange,
}: {
  mode: "light" | "dark";
  value: string | null;
  themeColor: string | null;
  surface: string | null;
  active: boolean;
  onChange: (value: string | null) => void;
}) {
  const shown = value ?? themeColor;
  const ratio = active && shown !== null && surface !== null ? contrastRatio(shown, surface) : null;
  return (
    <div
      className={cn(
        "flex flex-1 items-center gap-2 rounded-md border px-2 py-1.5",
        active ? "border-border" : "border-border/50",
      )}
    >
      <label className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border shadow-xs">
        <span className="absolute inset-0" style={{ backgroundColor: shown ?? "transparent" }} />
        <input
          type="color"
          aria-label={`${mode === "light" ? "Light" : "Dark"} mode color`}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={shown ?? "#000000"}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-xs text-foreground">{mode === "light" ? "Light" : "Dark"}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {value ?? "Theme"}
        </div>
      </div>
      {ratio === null ? null : <ContrastBadge ratio={ratio} />}
      {value === null ? null : (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Use the theme's ${mode} color`}
          title="Use theme color"
        >
          <Icon name="X" className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Light and dark text colors. The swatch for the appearance on screen shows
 * its contrast against the real message background.
 */
export function ColorField({
  label,
  value,
  surfaceVar,
  textVar = "--foreground",
  onChange,
}: {
  label: string;
  value: ColorChoice;
  surfaceVar: string;
  textVar?: string;
  onChange: (value: ColorChoice) => void;
}) {
  const appearance = useAppearance();
  const surface = useSurfaceColor(surfaceVar, appearance);
  const themeText = useSurfaceColor(textVar, appearance);
  const changed = value.light !== null || value.dark !== null;
  return (
    <FieldRow label={label} onReset={changed ? () => onChange({ light: null, dark: null }) : null}>
      <div className="flex gap-2">
        {(["light", "dark"] as const).map((mode) => (
          <Swatch
            key={mode}
            mode={mode}
            value={value[mode]}
            themeColor={mode === appearance ? themeText : null}
            surface={surface}
            active={mode === appearance}
            onChange={(next) => onChange({ ...value, [mode]: next })}
          />
        ))}
      </div>
    </FieldRow>
  );
}
