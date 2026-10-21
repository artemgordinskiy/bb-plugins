import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-telegram-notify",
    include: ["**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
