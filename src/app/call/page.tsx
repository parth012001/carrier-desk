import { asc } from "drizzle-orm";

import { CallConsole } from "@/components/call/call-console";
import { db, loads } from "@/db";
import { toBrokerLoad } from "@/lib/tools/sanitize";

/**
 * The call console.
 *
 * The board is server-rendered and handed down as props, which is the second
 * of the two channels this page uses: the policy band is the brokerage's own
 * data and belongs to the human audience, so it travels here through
 * `toBrokerLoad` rather than through the event stream. The stream carries no
 * ceiling at all and `src/lib/call/wire.test.ts` holds that line.
 *
 * `force-dynamic` because a covered load has to show as covered the moment
 * someone reloads, and the board is the record of that.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Call · carrier-desk",
};

export default async function CallPage() {
  const rows = await db.select().from(loads).orderBy(asc(loads.pickupStart), asc(loads.ref));

  return <CallConsole loads={rows.map(toBrokerLoad)} />;
}
