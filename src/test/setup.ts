import { beforeAll } from "vitest";

/**
 * Makes "tests must pass offline, on a plane, with the government API down"
 * mechanical instead of a convention.
 *
 * Every source takes an injectable `fetchImpl`; tests pass a stub. If one ever
 * forgets, this fails loudly and immediately rather than silently depending on
 * data.transportation.gov being reachable in CI.
 */
beforeAll(() => {
  globalThis.fetch = (input: RequestInfo | URL) => {
    throw new Error(
      `Test made a real network request to ${String(input)}. ` +
        `Tests must run offline — pass a fetchImpl stub or use a recorded fixture. ` +
        `See CLAUDE.md, "Testing bar".`,
    );
  };
});
