import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InMemoryLoadStore } from "@/lib/agent/ports/memory";
import { usd } from "@/lib/call/format";
import type { Offer } from "@/lib/call/projection";
import { type BrokerLoad, toBrokerLoad } from "@/lib/tools/sanitize";

import { RateLadder } from "./rate-ladder";

/**
 * The first component test in the project, and the reason `vitest.config.mts`
 * now matches `.tsx`: until it did, this file would have sat on disk reporting
 * nothing while the suite stayed green.
 *
 * No DOM. `RateLadder` is a pure function of its props with no hooks, so
 * rendering it to a string is the whole test — `environment: "node"` stays, and
 * jsdom stays a decision somebody makes deliberately rather than a default.
 *
 * The board comes from the real seeded rows through `toBrokerLoad`, so the band
 * being drawn is a real lane's policy rather than three numbers chosen to make
 * the assertions convenient.
 */

const REF = "LD-10401";
const OTHER = "LD-10402";

async function board(ref: string): Promise<BrokerLoad> {
  const load = await InMemoryLoadStore.fromSeed().byRef(ref);
  if (load === null) throw new Error(`no seeded load ${ref}`);
  return toBrokerLoad(load);
}

const offer = (loadRef: string, round: number, rateCents: number): Offer => ({
  loadRef,
  round,
  rateCents,
  askedCents: null,
  accepted: false,
});

describe("RateLadder", () => {
  it("plots only the offers made against this load", async () => {
    // A call can touch two lanes — the round counter is keyed by load precisely
    // because of that. An offer from the other lane carries money that means
    // nothing against this band, and above it the depth clamp parks it on the
    // ceiling rule: the one mark on the screen that is supposed to be
    // unreachable, showing an offer sitting exactly on it.
    const load = await board(REF);
    const strayRate = load.ceilingCents + 250_00;

    const markup = renderToStaticMarkup(
      <RateLadder
        load={load}
        offers={[offer(REF, 1, load.floorCents), offer(OTHER, 1, strayRate)]}
        booking={null}
      />,
    );

    expect(markup).toContain("offer 1");
    expect(markup).not.toContain("over ceiling");
    // The other lane's money is not on this chart in any form.
    expect(markup).not.toContain((strayRate / 100).toLocaleString("en-US"));
  });

  it("says an offer is over the ceiling rather than drawing it on the ceiling", async () => {
    // Should be impossible: the schedule tops out at market and `canBook`
    // enforces the ceiling independently. The clamp keeps a rung on the chart,
    // and it must not also make a violated invariant look like a satisfied one.
    const load = await board(REF);

    const markup = renderToStaticMarkup(
      <RateLadder
        load={load}
        offers={[offer(REF, 1, load.ceilingCents + 1)]}
        booking={null}
      />,
    );

    expect(markup).toContain("over ceiling");
    expect(markup).not.toContain("offer 1");
    // And the ceiling still says what it is. A breach clamps to the top of the
    // chart, so the collision rule silenced the ceiling's own number at exactly
    // the moment the two need to be readable side by side.
    expect(markup).toContain(usd(load.ceilingCents));
  });

  it("says nothing was quoted when only another lane was", async () => {
    const load = await board(REF);

    const markup = renderToStaticMarkup(
      <RateLadder load={load} offers={[offer(OTHER, 1, load.floorCents)]} booking={null} />,
    );

    expect(markup).toContain("No rate quoted yet.");
  });
});
