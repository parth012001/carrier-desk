import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The suite must pass offline, on a plane, with the government API down.
 * Nothing here loads .env — any module that needs a live connection is behind
 * a port and gets a fake in tests. See docs/DECISIONS.md and CLAUDE.md.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // mirrors the "@/*" path in tsconfig.json
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
