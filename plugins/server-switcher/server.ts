// bb-plugin-server-switcher backend: declares the server list setting. The
// sidebar disclosure in app.tsx reads it through useSettings().
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseServers } from "./servers";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    servers: {
      type: "string",
      label: "Servers",
      description:
        "One server per line as <name> <url>, e.g. `work https://bb-work.example.com`. Lines starting with # are ignored.",
      experimental_multiline: true,
      experimental_schema: z.string().superRefine((value, ctx) => {
        const result = parseServers(value);
        if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
      }),
      default: "",
    },
  });
}
