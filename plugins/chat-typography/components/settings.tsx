// The plugin's settings page: presets, then per-role controls beside a live
// preview. Every change applies to open chats immediately.
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BUNDLED_FONTS } from "../fonts";
import { useConfig } from "../store";
import {
  DEFAULT_CONFIG,
  LIMITS,
  PRESETS,
  fontStack,
  type DerivedFontChoice,
  type FontChoice,
  type ProseStyle,
  type TypographyConfig,
} from "../typography";
import { ColorField, SliderField, SwitchField } from "./fields";
import { FontPicker } from "./font-picker";
import { Preview } from "./preview";

const px = (value: number) => `${value}px`;
const times = (value: number) => `${value.toFixed(2)}×`;
const em = (value: number) => `${value >= 0 ? "" : "−"}${Math.abs(value).toFixed(3)}em`;

function same(a: TypographyConfig, b: TypographyConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function PresetCard({
  label,
  description,
  family,
  active,
  onSelect,
}: {
  label: string;
  description: string;
  family: string | null;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "group flex cursor-pointer flex-col items-start gap-1 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50",
        active ? "border-foreground/60 ring-1 ring-foreground/20" : "border-border",
      )}
    >
      <span className="text-[26px] leading-none text-foreground" style={{ fontFamily: family ?? undefined }}>
        Aa
      </span>
      <span className="mt-1.5 text-xs font-medium text-foreground">{label}</span>
      <span className="text-[11px] leading-tight text-muted-foreground">{description}</span>
    </button>
  );
}

function ProseControls({
  style,
  defaults,
  onChange,
  surfaceVar,
}: {
  style: ProseStyle;
  defaults: ProseStyle;
  onChange: (next: ProseStyle) => void;
  surfaceVar: string;
}) {
  const set = <K extends keyof ProseStyle>(key: K, value: ProseStyle[K]) => onChange({ ...style, [key]: value });
  return (
    <>
      <div className="grid gap-5 @md:grid-cols-2">
        <SliderField
          label="Size"
          value={style.size}
          defaultValue={defaults.size}
          limits={LIMITS.size}
          format={px}
          onChange={(value) => set("size", value)}
        />
        <SliderField
          label="Line height"
          value={style.lineHeight}
          defaultValue={defaults.lineHeight}
          limits={LIMITS.lineHeight}
          format={(value) => `${times(value)} · ${Math.round(value * style.size)}px`}
          onChange={(value) => set("lineHeight", value)}
        />
        <SliderField
          label="Weight"
          value={style.weight}
          defaultValue={defaults.weight}
          limits={LIMITS.weight}
          format={String}
          onChange={(value) => set("weight", value)}
        />
        <SliderField
          label="Letter spacing"
          value={style.letterSpacing}
          defaultValue={defaults.letterSpacing}
          limits={LIMITS.letterSpacing}
          format={em}
          onChange={(value) => set("letterSpacing", value)}
        />
      </div>
      <ColorField label="Text color" value={style.color} surfaceVar={surfaceVar} onChange={(value) => set("color", value)} />
    </>
  );
}

export function SettingsPage() {
  const [config, save] = useConfig();
  const update = (patch: Partial<TypographyConfig>) => save({ ...config, ...patch });
  const repliesFamily = fontStack(config.replies.font, "prose");
  const resolve = (choice: DerivedFontChoice): FontChoice => (choice.kind === "same" ? config.replies.font : choice);

  return (
    <div className="@container space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
        <div className="min-w-0 flex-1">
          <SwitchField
            label="Restyle chat messages"
            description="Applies to replies and your messages in every thread, on this device only."
            checked={config.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={same(config, DEFAULT_CONFIG)}
          onClick={() => save(DEFAULT_CONFIG)}
        >
          Reset all
        </Button>
      </div>

      <div className={cn("space-y-6", !config.enabled && "pointer-events-none opacity-50")} aria-disabled={!config.enabled}>
        <section className="space-y-2" aria-label="Presets">
          <h4 className="text-xs font-medium text-foreground">Start from a preset</h4>
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
            {PRESETS.map((preset) => {
              const next = preset.apply(config);
              return (
                <PresetCard
                  key={preset.id}
                  label={preset.label}
                  description={preset.description}
                  family={fontStack(next.replies.font, "prose")}
                  active={same(next, config)}
                  onSelect={() => save(next)}
                />
              );
            })}
          </div>
        </section>

        <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Tabs defaultValue="replies" className="@container min-w-0 space-y-5">
            <TabsList className="flex h-auto w-full flex-wrap justify-start">
              <TabsTrigger value="replies">Replies</TabsTrigger>
              <TabsTrigger value="messages">Your messages</TabsTrigger>
              <TabsTrigger value="headings">Headings</TabsTrigger>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="rhythm">Spacing</TabsTrigger>
            </TabsList>

            <TabsContent value="replies" className="space-y-5">
              <FontPicker
                label="Reply font"
                role="prose"
                value={config.replies.font}
                onChange={(font) => font.kind !== "same" && update({ replies: { ...config.replies, font } })}
              />
              <ProseControls
                style={config.replies}
                defaults={DEFAULT_CONFIG.replies}
                surfaceVar="--background"
                onChange={(style) => update({ replies: { ...config.replies, ...style } })}
              />
            </TabsContent>

            <TabsContent value="messages" className="space-y-5">
              <FontPicker
                label="Your message font"
                role="prose"
                value={config.messages.font}
                sameLabel="Same as replies"
                sameFamily={repliesFamily}
                onChange={(font) => update({ messages: { ...config.messages, font } })}
              />
              <ProseControls
                style={config.messages}
                defaults={DEFAULT_CONFIG.messages}
                surfaceVar="--surface-recessed"
                onChange={(style) => update({ messages: { ...config.messages, ...style } })}
              />
            </TabsContent>

            <TabsContent value="headings" className="space-y-5">
              <FontPicker
                label="Heading font"
                role="prose"
                value={config.headings.font}
                sameLabel="Same as body text"
                sameFamily={repliesFamily}
                onChange={(font) => update({ headings: { ...config.headings, font } })}
              />
              <div className="grid gap-5 @md:grid-cols-2">
                <SliderField
                  label="Weight"
                  value={config.headings.weight}
                  defaultValue={DEFAULT_CONFIG.headings.weight}
                  limits={LIMITS.headingWeight}
                  format={String}
                  onChange={(weight) => update({ headings: { ...config.headings, weight } })}
                />
                <SliderField
                  label="Size"
                  value={config.headings.scale}
                  defaultValue={DEFAULT_CONFIG.headings.scale}
                  limits={LIMITS.headingScale}
                  format={times}
                  onChange={(scale) => update({ headings: { ...config.headings, scale } })}
                />
                <SliderField
                  label="Letter spacing"
                  value={config.headings.letterSpacing}
                  defaultValue={DEFAULT_CONFIG.headings.letterSpacing}
                  limits={LIMITS.letterSpacing}
                  format={em}
                  onChange={(letterSpacing) => update({ headings: { ...config.headings, letterSpacing } })}
                />
              </div>
              <ColorField
                label="Heading color"
                value={config.headings.color}
                surfaceVar="--background"
                onChange={(color) => update({ headings: { ...config.headings, color } })}
              />
            </TabsContent>

            <TabsContent value="code" className="space-y-5">
              <FontPicker
                label="Code font"
                role="code"
                value={config.code.font}
                onChange={(font) => font.kind !== "same" && update({ code: { ...config.code, font } })}
              />
              <div className="grid gap-5 @md:grid-cols-2">
                <SliderField
                  label="Size"
                  value={config.code.size}
                  defaultValue={DEFAULT_CONFIG.code.size}
                  limits={LIMITS.codeSize}
                  format={(value) => `${Math.round(value * 100)}% · ${(value * config.replies.size).toFixed(1)}px`}
                  onChange={(size) => update({ code: { ...config.code, size } })}
                  hint="Relative to the text around it."
                />
                <SliderField
                  label="Block line height"
                  value={config.code.lineHeight}
                  defaultValue={DEFAULT_CONFIG.code.lineHeight}
                  limits={LIMITS.codeLineHeight}
                  format={times}
                  onChange={(lineHeight) => update({ code: { ...config.code, lineHeight } })}
                />
              </div>
              <SwitchField
                label="Ligatures"
                description="Join sequences like => and != into single glyphs, where the font has them."
                checked={config.code.ligatures}
                onChange={(ligatures) => update({ code: { ...config.code, ligatures } })}
              />
            </TabsContent>

            <TabsContent value="rhythm" className="space-y-5">
              <div className="grid gap-5 @md:grid-cols-2">
                <SliderField
                  label="Paragraph spacing"
                  value={config.rhythm.paragraphSpacing}
                  defaultValue={DEFAULT_CONFIG.rhythm.paragraphSpacing}
                  limits={LIMITS.paragraphSpacing}
                  format={(value) => `${value.toFixed(2)}em`}
                  onChange={(paragraphSpacing) => update({ rhythm: { ...config.rhythm, paragraphSpacing } })}
                />
                <SliderField
                  label="Dark mode weight"
                  value={config.rhythm.darkWeightOffset}
                  defaultValue={DEFAULT_CONFIG.rhythm.darkWeightOffset}
                  limits={LIMITS.darkWeightOffset}
                  format={(value) => (value > 0 ? `+${value}` : value === 0 ? "±0" : `−${-value}`)}
                  onChange={(darkWeightOffset) => update({ rhythm: { ...config.rhythm, darkWeightOffset } })}
                  hint="Light text on dark backgrounds looks heavier; a little lighter evens it out."
                />
              </div>
              <SwitchField
                label="Even line endings"
                description="Avoid single words stranded on a paragraph's last line."
                checked={config.rhythm.textWrap === "pretty"}
                onChange={(pretty) => update({ rhythm: { ...config.rhythm, textWrap: pretty ? "pretty" : "auto" } })}
              />
              <SwitchField
                label="Hyphenation"
                description="Break long words at line ends. Best with long-form prose."
                checked={config.rhythm.hyphens}
                onChange={(hyphens) => update({ rhythm: { ...config.rhythm, hyphens } })}
              />
              <SwitchField
                label="Optical sizing"
                description="Let fonts with optical sizes adapt their shapes to the text size."
                checked={config.rhythm.opticalSizing}
                onChange={(opticalSizing) => update({ rhythm: { ...config.rhythm, opticalSizing } })}
              />
            </TabsContent>
          </Tabs>

          <div className="min-w-0 @3xl:sticky @3xl:top-4">
            <Preview enabled={config.enabled} />
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Included fonts: {BUNDLED_FONTS.map((font) => font.label).join(", ")} (SIL Open Font License).
              {resolve(config.messages.font).kind === "device" || config.replies.font.kind === "device"
                ? " Device fonts only show on devices that have them installed."
                : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
