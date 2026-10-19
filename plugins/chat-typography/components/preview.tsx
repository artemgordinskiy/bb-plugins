// A short exchange rendered with bb's own message markdown, so the preview
// is styled by exactly the rules applied to the chat.
import { Markdown } from "@get-bb/plugin-sdk/app";
import { useAppearance } from "../color";

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

export function Preview({ enabled }: { enabled: boolean }) {
  const appearance = useAppearance();
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-background">
      <figcaption className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>Preview</span>
        <span>
          {enabled ? (appearance === "dark" ? "Dark appearance" : "Light appearance") : "Plugin off — bb's default styling"}
        </span>
      </figcaption>
      <div className="space-y-5 px-4 py-5">
        <div className="flex justify-end">
          <div
            data-chat-typography-sample="messages"
            className="max-w-[85%] rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5"
          >
            <Markdown content={USER_SAMPLE} />
          </div>
        </div>
        <div data-chat-typography-sample="replies" className="px-2">
          <Markdown content={REPLY_SAMPLE} />
        </div>
      </div>
    </figure>
  );
}
