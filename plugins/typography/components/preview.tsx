// Live previews. The chat sample is rendered with bb's own message markdown
// and the specimens with bb's own tokens, so each one is styled by exactly
// the rules applied to the app.
import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { useAppearance } from "../color";
import type { TextToken, ThemeTokens } from "../typography";

const USER_SAMPLE = "Can long replies read more like a **book** than a terminal? Something easy on the eyes at night.";

const REPLY_SAMPLE = `## Reading, not scanning

Good typography disappears. A comfortable size, open line spacing and a line of roughly seventy characters let the eye return to the start of each line without hunting for it.

- Literata was drawn for long reading on screens.
- Optical sizing opens small text and tightens large headings.

Inline \`code\` stays distinct, and blocks keep their own rhythm:

\`\`\`ts
const measure = "66ch"; // about twelve words a line
\`\`\`

> The best typeface is the one you stop noticing.`;

const CODE_SAMPLE = `\`\`\`ts
export function clamp(value: number, min = 0, max = 1): number {
  if (value !== value) return min; // NaN => min
  return value <= min ? min : value >= max ? max : value;
}
\`\`\``;

function Frame({ title, status, children }: { title: string; status?: string; children: ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-background">
      <figcaption className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>{title}</span>
        {status ? <span className="truncate">{status}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

export function ChatPreview({ enabled }: { enabled: boolean }) {
  const appearance = useAppearance();
  return (
    <Frame
      title="Preview"
      status={enabled ? (appearance === "dark" ? "Dark appearance" : "Light appearance") : "Off — bb's default styling"}
    >
      <div className="space-y-5 px-4 py-5">
        <div className="flex justify-end">
          <div
            data-typography-sample="messages"
            className="max-w-[85%] rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5"
          >
            <Markdown content={USER_SAMPLE} />
          </div>
        </div>
        <div data-typography-sample="replies" className="px-2">
          <Markdown content={REPLY_SAMPLE} />
        </div>
        <div className="rounded-xl border border-border bg-background px-4 pb-3 pt-3 shadow-xs">
          <div data-typography-sample="composer" className="text-sm leading-[1.7] text-foreground">
            Could the message box match too?
          </div>
          <div className="mt-2 text-xs text-muted-foreground">Message box</div>
        </div>
      </div>
    </Frame>
  );
}

const SCALE: { token: TextToken; className: string; use: string }[] = [
  { token: "--text-xs", className: "text-xs", use: "Labels, timestamps, badges" },
  { token: "--text-sm", className: "text-sm", use: "Sidebar, menus, settings" },
  { token: "--text-base", className: "text-base", use: "Dialog and page text" },
  { token: "--text-lg", className: "text-lg font-medium", use: "Titles" },
];

/** A slice of bb's chrome and its type scale, in the live interface tokens. */
export function InterfaceSpecimen({ theme, scale }: { theme: ThemeTokens; scale: number }) {
  return (
    <Frame title="Interface" status={scale === 1 ? "Theme scale" : `${Math.round(scale * 100)}% of the theme scale`}>
      <div className="grid gap-4 p-4 @lg:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="space-y-0.5 rounded-lg border border-border bg-surface-recessed p-1.5 font-sans">
          {["Typography plugin", "Fix flaky deploy check", "Plan the NAS upgrade"].map((title, index) => (
            <div
              key={title}
              className={
                index === 0
                  ? "rounded-md bg-background px-2 py-1.5 text-sm text-foreground shadow-xs"
                  : "rounded-md px-2 py-1.5 text-sm text-muted-foreground"
              }
            >
              <div className="truncate">{title}</div>
              <div className="text-xs text-muted-foreground">{index === 0 ? "Working…" : `${index + 1}h ago`}</div>
            </div>
          ))}
        </div>
        <dl className="min-w-0 space-y-2.5 font-sans">
          {SCALE.map(({ token, className, use }) => {
            const size = theme.text[token];
            return (
              <div key={token} className="flex items-baseline gap-3">
                <dt className={`${className} min-w-0 flex-1 truncate text-foreground`}>{use}</dt>
                <dd className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {size === undefined ? token : `${(size * scale).toFixed(1).replace(/\.0$/, "")}px`}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Frame>
  );
}

/** A code block as bb draws it, and a terminal line in the terminal's font. */
export function CodeSpecimen({ ligatures }: { ligatures: boolean }) {
  return (
    <Frame title="Code" status={ligatures ? "Ligatures on" : "Ligatures off"}>
      <div className="space-y-3 p-4">
        <Markdown content={CODE_SAMPLE} />
        <div
          className="overflow-x-auto rounded-lg border border-border bg-surface-recessed px-3 py-2.5 text-[12px] leading-[1.45] text-foreground"
          style={{ fontFamily: "var(--font-terminal)" }}
        >
          <div className="whitespace-pre">
            <span className="text-muted-foreground">~/projects/homelab main ❯</span> git log --oneline -1
          </div>
          <div className="whitespace-pre text-muted-foreground">033c11a Record UniFi IPS exclusions =&gt; CT135</div>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Diffs and file views use the code font at bb's sizes. The terminal stays at 12px and picks up a new font
          when it reopens.
        </p>
      </div>
    </Frame>
  );
}
