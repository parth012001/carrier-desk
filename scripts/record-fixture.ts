/**
 * Records a real Socrata response and freezes it as an offline fixture.
 *
 * Run by hand, never by the suite. Tests must pass offline with the government
 * API down, so every fixture under src/lib/carriers/__fixtures__/socrata/ is a
 * real recording made by this script and then left alone.
 *
 *   pnpm fixture:record 186800 active
 *   pnpm fixture:record 9999999 not-found
 *
 * The second argument is a label that goes in the filename, so the fixture set
 * reads as the case list it is: mc-186800.active.json, mc-143229.ambiguous.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseMcNumber } from "../src/lib/carriers/normalize";

const DATASET_URL = "https://data.transportation.gov/resource/az4n-8mr2.json";
const FIXTURE_DIR = path.join(process.cwd(), "src/lib/carriers/__fixtures__/socrata");

async function main() {
  const [rawMc, label] = process.argv.slice(2);
  if (!rawMc || !label) {
    console.error("usage: pnpm fixture:record <mcNumber> <label>");
    process.exit(1);
  }

  const mcNumber = parseMcNumber(rawMc);
  if (mcNumber === null) {
    console.error(`"${rawMc}" is not a valid MC number`);
    process.exit(1);
  }

  const where = [1, 2, 3]
    .map((slot) => `(docket${slot}='${mcNumber}' AND docket${slot}prefix='MC')`)
    .join(" OR ");

  const url = new URL(DATASET_URL);
  url.searchParams.set("$where", where);
  url.searchParams.set("$limit", "50");

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Socrata returned ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  const rows = (await response.json()) as unknown[];
  await mkdir(FIXTURE_DIR, { recursive: true });

  const file = path.join(FIXTURE_DIR, `mc-${mcNumber}.${label}.json`);
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  console.log(`Recorded ${rows.length} row(s) -> ${path.relative(process.cwd(), file)}`);
  for (const row of rows as Record<string, string>[]) {
    console.log(
      `  DOT ${row.dot_number} | ${row.legal_name} | entity ${row.status_code}` +
        ` | docket ${row.docket1_status_code ?? "-"} | rating ${row.safety_rating ?? "-"}` +
        ` | ${row.power_units ?? "-"} power units`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
