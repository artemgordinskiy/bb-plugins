// bb-plugin-typography backend: serves the bundled fonts. Everything
// else runs in the browser; settings are stored per device.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { FONT_FACES } from "./font-faces";

export const FONT_ROUTE = "/font";

/** fonts/ beside server.ts (path install) or beside dist/server.js (built). */
function fontsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, "fonts"), join(moduleDir, "..", "fonts")];
  const found = candidates.find((candidate) => existsSync(join(candidate, FONT_FACES[0]!.file)));
  if (found === undefined) throw new Error(`bundled fonts not found in ${candidates.join(" or ")}`);
  return found;
}

export default async function plugin(bb: BbPluginApi) {
  const dir = fontsDir();
  const files = new Set(FONT_FACES.map((face) => face.file));

  bb.http.route("GET", FONT_ROUTE, async (context) => {
    const file = context.req.query("file");
    if (file === undefined || !files.has(file)) return context.json({ error: "unknown font" }, 404);
    return new Response(new Uint8Array(await readFile(join(dir, file))), {
      headers: {
        "content-type": "font/woff2",
        // Font files only change with a plugin release; a day of caching
        // avoids refetching them on every app load.
        "cache-control": "public, max-age=86400",
      },
    });
  });

  bb.log.info(`serving ${files.size} bundled font files`);
}
