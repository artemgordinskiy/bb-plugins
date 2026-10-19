// The plugin's settings page, in three areas: chat reading typography (with
// presets and a preview), bb's interface font and size, and the monospace
// font used for code everywhere. Every change applies immediately, on this
// device only.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BUNDLED_FONTS } from "../fonts";
import { useConfig } from "../store";
import { overriddenTokens, useThemeTokens } from "../theme";
import {
  DEFAULT_CONFIG,
  LIMITS,
  PRESETS,
  fontStack,
  resolveFont,
  themeBaseSize,
  type ChatConfig,
  type DerivedFontChoice,
  type ProseStyle,
  type ThemeTokens,
  type TypographyConfig,
} from "../typography";
import { ColorField, SliderField, SwitchField } from "./fields";
import { FontPicker, type AliasOption } from "./font-picker";
import { ChatPreview, CodeSpecimen, InterfaceSpecimen } from "./preview";

const px = (value: number) => `${value}px`;
const times = (value: number) => `${value.toFixed(2)}×`;
const em = (value: number) => `${value >= 0 ? "" : "−"}${Math.abs(value).toFixed(3)}em`;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const dimmed = (off: boolean) => cn(off && "pointer-events-none opacity-50");

function SectionHeader({
  title,
  description,
  onReset,
  children,
}: {
  title: string;
  description: string;
  onReset: (() => void) | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="text-xs leading-snug text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        {children}
        <Button variant="ghost" size="sm" disabled={onReset === null} onClick={onReset ?? undefined}>
          Reset
        </Button>
      </div>
    </div>
  );
}

/** Two columns on wide pages: controls, then a preview that stays in view. */
function Split({ controls, preview }: { controls: ReactNode; preview: ReactNode }) {
  return (
    <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="@container min-w-0 space-y-5">{controls}</div>
      <div className="min-w-0 @3xl:sticky @3xl:top-4">{preview}</div>
    </div>
  );
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

/** Font stacks for drawing each picker's alias options. */
function aliases(config: TypographyConfig, theme: ThemeTokens) {
  const interfaceFamily = fontStack(config.interface.font, theme.fontSans) ?? theme.fontSans;
  const codeFamily = fontStack(config.code.font, theme.fontMono) ?? theme.fontMono;
  const repliesFamily = fontStack(config.chat.replies.font, interfaceFamily) ?? interfaceFamily;
  const interfaceOption: AliasOption = {
    label: "Interface font",
    detail: "Follows the Interface tab",
    family: interfaceFamily,
  };
  return { interfaceFamily, codeFamily, repliesFamily, interfaceOption };
}

function ChatSection({
  config,
  theme,
  onChange,
}: {
  config: TypographyConfig;
  theme: ThemeTokens;
  onChange: (chat: ChatConfig) => void;
}) {
  const chat = config.chat;
  const defaults = DEFAULT_CONFIG.chat;
  const { codeFamily, repliesFamily, interfaceFamily, interfaceOption } = aliases(config, theme);
  const update = (patch: Partial<ChatConfig>) => onChange({ ...chat, ...patch });
  const usesDeviceFont = [chat.replies.font, resolveFont(chat.messages.font, chat.replies.font)].some(
    (font) => font.kind === "device",
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Chat"
        description="Reading typography for replies and your messages in every thread."
        onReset={same(chat, defaults) ? null : () => onChange(defaults)}
      >
        <SwitchField label="On" checked={chat.enabled} onChange={(enabled) => update({ enabled })} />
      </SectionHeader>

      <div className={cn("space-y-6", dimmed(!chat.enabled))} aria-disabled={!chat.enabled}>
        <section className="space-y-2" aria-label="Presets">
          <h5 className="text-xs font-medium text-foreground">Start from a preset</h5>
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
            {PRESETS.map((preset) => {
              const next = preset.apply(chat);
              return (
                <PresetCard
                  key={preset.id}
                  label={preset.label}
                  description={preset.description}
                  family={fontStack(next.replies.font, interfaceFamily) ?? interfaceFamily}
                  active={same(next, chat)}
                  onSelect={() => onChange(next)}
                />
              );
            })}
          </div>
        </section>

        <Split
          controls={
            <Tabs defaultValue="replies" className="space-y-5">
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
                  role="text"
                  value={chat.replies.font}
                  theme={interfaceOption}
                  onChange={(font) => font.kind !== "same" && update({ replies: { ...chat.replies, font } })}
                />
                <ProseControls
                  style={chat.replies}
                  defaults={defaults.replies}
                  surfaceVar="--background"
                  onChange={(style) => update({ replies: { ...chat.replies, ...style } })}
                />
              </TabsContent>

              <TabsContent value="messages" className="space-y-5">
                <FontPicker
                  label="Your message font"
                  role="text"
                  value={chat.messages.font}
                  same={{ label: "Same as replies", family: repliesFamily }}
                  theme={interfaceOption}
                  onChange={(font) => update({ messages: { ...chat.messages, font } })}
                />
                <ProseControls
                  style={chat.messages}
                  defaults={defaults.messages}
                  surfaceVar="--surface-recessed"
                  onChange={(style) => update({ messages: { ...chat.messages, ...style } })}
                />
                <SwitchField
                  label="Message box"
                  description="Write in this type too, so a draft reads as it will once sent. Off keeps the interface font."
                  checked={chat.messages.composer}
                  onChange={(composer) => update({ messages: { ...chat.messages, composer } })}
                />
              </TabsContent>

              <TabsContent value="headings" className="space-y-5">
                <FontPicker
                  label="Heading font"
                  role="text"
                  value={chat.headings.font}
                  same={{ label: "Same as body text", detail: "Each message's own font", family: repliesFamily }}
                  theme={interfaceOption}
                  onChange={(font) => update({ headings: { ...chat.headings, font } })}
                />
                <div className="grid gap-5 @md:grid-cols-2">
                  <SliderField
                    label="Weight"
                    value={chat.headings.weight}
                    defaultValue={defaults.headings.weight}
                    limits={LIMITS.headingWeight}
                    format={String}
                    onChange={(weight) => update({ headings: { ...chat.headings, weight } })}
                  />
                  <SliderField
                    label="Size"
                    value={chat.headings.scale}
                    defaultValue={defaults.headings.scale}
                    limits={LIMITS.headingScale}
                    format={times}
                    onChange={(scale) => update({ headings: { ...chat.headings, scale } })}
                  />
                  <SliderField
                    label="Letter spacing"
                    value={chat.headings.letterSpacing}
                    defaultValue={defaults.headings.letterSpacing}
                    limits={LIMITS.letterSpacing}
                    format={em}
                    onChange={(letterSpacing) => update({ headings: { ...chat.headings, letterSpacing } })}
                  />
                </div>
                <ColorField
                  label="Heading color"
                  value={chat.headings.color}
                  surfaceVar="--background"
                  onChange={(color) => update({ headings: { ...chat.headings, color } })}
                />
              </TabsContent>

              <TabsContent value="code" className="space-y-5">
                <FontPicker
                  label="Chat code font"
                  role="code"
                  value={chat.code.font}
                  same={{ label: "Same as code font", detail: "Follows the Code tab", family: codeFamily }}
                  theme={null}
                  onChange={(font) => update({ code: { ...chat.code, font } })}
                />
                <div className="grid gap-5 @md:grid-cols-2">
                  <SliderField
                    label="Size"
                    value={chat.code.size}
                    defaultValue={defaults.code.size}
                    limits={LIMITS.codeSize}
                    format={(value) => `${Math.round(value * 100)}% · ${(value * chat.replies.size).toFixed(1)}px`}
                    onChange={(size) => update({ code: { ...chat.code, size } })}
                    hint="Relative to the text around it."
                  />
                  <SliderField
                    label="Block line height"
                    value={chat.code.lineHeight}
                    defaultValue={defaults.code.lineHeight}
                    limits={LIMITS.codeLineHeight}
                    format={times}
                    onChange={(lineHeight) => update({ code: { ...chat.code, lineHeight } })}
                  />
                </div>
              </TabsContent>

              <TabsContent value="rhythm" className="space-y-5">
                <div className="grid gap-5 @md:grid-cols-2">
                  <SliderField
                    label="Paragraph spacing"
                    value={chat.rhythm.paragraphSpacing}
                    defaultValue={defaults.rhythm.paragraphSpacing}
                    limits={LIMITS.paragraphSpacing}
                    format={(value) => `${value.toFixed(2)}em`}
                    onChange={(paragraphSpacing) => update({ rhythm: { ...chat.rhythm, paragraphSpacing } })}
                  />
                  <SliderField
                    label="Dark mode weight"
                    value={chat.rhythm.darkWeightOffset}
                    defaultValue={defaults.rhythm.darkWeightOffset}
                    limits={LIMITS.darkWeightOffset}
                    format={(value) => (value > 0 ? `+${value}` : value === 0 ? "±0" : `−${-value}`)}
                    onChange={(darkWeightOffset) => update({ rhythm: { ...chat.rhythm, darkWeightOffset } })}
                    hint="Light text on dark backgrounds looks heavier; a little lighter evens it out."
                  />
                </div>
                <SwitchField
                  label="Even line endings"
                  description="Avoid single words stranded on a paragraph's last line."
                  checked={chat.rhythm.textWrap === "pretty"}
                  onChange={(pretty) => update({ rhythm: { ...chat.rhythm, textWrap: pretty ? "pretty" : "auto" } })}
                />
                <SwitchField
                  label="Hyphenation"
                  description="Break long words at line ends. Best with long-form prose."
                  checked={chat.rhythm.hyphens}
                  onChange={(hyphens) => update({ rhythm: { ...chat.rhythm, hyphens } })}
                />
                <SwitchField
                  label="Optical sizing"
                  description="Let fonts with optical sizes adapt their shapes to the text size."
                  checked={chat.rhythm.opticalSizing}
                  onChange={(opticalSizing) => update({ rhythm: { ...chat.rhythm, opticalSizing } })}
                />
              </TabsContent>
            </Tabs>
          }
          preview={
            <>
              <ChatPreview enabled={config.enabled && chat.enabled} />
              {usesDeviceFont ? (
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                  Device fonts only show on devices that have them installed.
                </p>
              ) : null}
            </>
          }
        />
      </div>
    </div>
  );
}

function InterfaceSection({
  config,
  theme,
  onChange,
}: {
  config: TypographyConfig;
  theme: ThemeTokens;
  onChange: (next: TypographyConfig["interface"]) => void;
}) {
  const ui = config.interface;
  const base = themeBaseSize(theme);
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Interface"
        description="The sidebar, menus and settings. The theme's own face and scale until you change them."
        onReset={same(ui, DEFAULT_CONFIG.interface) ? null : () => onChange(DEFAULT_CONFIG.interface)}
      />
      <Split
        controls={
          <>
            <FontPicker
              label="Interface font"
              role="text"
              value={ui.font}
              theme={{ label: "Theme font", detail: "Whatever your bb theme uses", family: theme.fontSans }}
              onChange={(font) => font.kind !== "same" && onChange({ ...ui, font })}
            />
            <SliderField
              label="Base size"
              value={ui.size ?? base}
              defaultValue={base}
              limits={LIMITS.interfaceSize}
              format={(value) => (ui.size === null ? `${px(value)} · theme` : px(value))}
              // Landing back on the theme's size is the same as not overriding it.
              onChange={(size) => onChange({ ...ui, size: size === base ? null : size })}
              hint="Scales every interface text size together. Spacing stays as it is."
            />
          </>
        }
        preview={<InterfaceSpecimen theme={theme} scale={(ui.size ?? base) / base} />}
      />
    </div>
  );
}

function CodeSection({
  config,
  theme,
  onChange,
}: {
  config: TypographyConfig;
  theme: ThemeTokens;
  onChange: (next: TypographyConfig["code"]) => void;
}) {
  const code = config.code;
  const { codeFamily } = aliases(config, theme);
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Code"
        description="Monospace everywhere: code blocks, file views, diffs and the terminal."
        onReset={same(code, DEFAULT_CONFIG.code) ? null : () => onChange(DEFAULT_CONFIG.code)}
      />
      <Split
        controls={
          <>
            <FontPicker
              label="Code font"
              role="code"
              value={code.font}
              theme={{ label: "Theme font", detail: "bb's system monospace", family: theme.fontMono }}
              onChange={(font) => font.kind !== "same" && onChange({ ...code, font })}
            />
            <FontPicker
              label="Terminal font"
              role="code"
              value={code.terminal}
              same={{ label: "Same as code font", detail: "With bb's Nerd Font symbols behind it", family: codeFamily }}
              theme={{ label: "Theme font", detail: "bb's Nerd Font stack", family: theme.fontTerminal }}
              onChange={(terminal: DerivedFontChoice) => onChange({ ...code, terminal })}
            />
            <SwitchField
              label="Ligatures"
              description={
                <>
                  Join sequences like <code className="font-mono">=&gt;</code> and{" "}
                  <code className="font-mono">!=</code> into single glyphs, where the font has them.
                </>
              }
              checked={code.ligatures}
              onChange={(ligatures) => onChange({ ...code, ligatures })}
            />
          </>
        }
        preview={<CodeSpecimen ligatures={code.ligatures} />}
      />
    </div>
  );
}

const TOKEN_AREAS: Record<string, string> = { "--font-sans": "interface", "--font-mono": "code" };

export function SettingsPage() {
  const [config, save] = useConfig();
  const theme = useThemeTokens();
  const overridden = overriddenTokens(config, theme).map((token) => TOKEN_AREAS[token] ?? token);
  const update = (patch: Partial<TypographyConfig>) => save({ ...config, ...patch });

  return (
    <div className="@container space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
        <div className="min-w-0 flex-1">
          <SwitchField
            label="Typography"
            description="Fonts and sizes for chat, the interface and code, on this device only."
            checked={config.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        </div>
        <Button variant="outline" size="sm" disabled={same(config, DEFAULT_CONFIG)} onClick={() => save(DEFAULT_CONFIG)}>
          Reset all
        </Button>
      </div>

      {overridden.length > 0 ? (
        <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-xs leading-snug text-foreground">
          Something else on this page sets the {overridden.join(" and ")} font with higher priority, so that choice
          here has no effect. The Fonts plugin does this; disable it to use these settings.
        </p>
      ) : null}

      <Tabs defaultValue="chat" className={cn("space-y-6", dimmed(!config.enabled))} aria-disabled={!config.enabled}>
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="interface">Interface</TabsTrigger>
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">
          <ChatSection config={config} theme={theme} onChange={(chat) => update({ chat })} />
        </TabsContent>
        <TabsContent value="interface">
          <InterfaceSection config={config} theme={theme} onChange={(ui) => update({ interface: ui })} />
        </TabsContent>
        <TabsContent value="code">
          <CodeSection config={config} theme={theme} onChange={(code) => update({ code })} />
        </TabsContent>
      </Tabs>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Included fonts: {BUNDLED_FONTS.map((font) => font.label).join(", ")} (SIL Open Font License).
      </p>
    </div>
  );
}
