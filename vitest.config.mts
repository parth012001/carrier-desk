import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The suite must pass offline, on a plane, with the government API down.
 * Nothing here loads .env — any module that needs a live connection is behind
 * a port and gets a fake in tests. See docs/DECISIONS.md and CLAUDE.md.
 *
 * setup.ts makes that mechanical: it replaces global fetch with one that
 * throws, so a test that reaches for the network fails instead of quietly
 * depending on data.transportation.gov being up.
 */
export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` as well, because this project has components now and a pattern that
    // cannot see them does not fail — it reports green on a file it never ran.
    // Still `environment: "node"`: nothing here needs a DOM. `renderToStaticMarkup`
    // renders a pure component to a string, which is what the ladder's guards are
    // about. A test that does need one has to say so, and adding jsdom is a
    // decision rather than a default.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      // mirrors the "@/*" path in tsconfig.json
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
