// Generates src/server/tax/us-zip-states.generated.json from config/zip_code_database.csv, the file
// config/initializers/united_states_zip_codes.rb loads into ZIP_CODE_TO_STATE. Rows are grouped by state to keep the
// JSON small. `--check` fails when the committed JSON no longer matches the CSV.
import { readFileSync, writeFileSync } from "node:fs";

const CSV_PATH = new URL("../../config/zip_code_database.csv", import.meta.url);
const OUT_PATH = new URL("../src/server/tax/us-zip-states.generated.json", import.meta.url);

const rows = readFileSync(CSV_PATH, "utf8").split("\n").slice(1).filter((line) => line.length > 0);
const byState: Record<string, string[]> = {};
// Later rows win, as in the Ruby Hash built from the CSV.
const zipToState = new Map<string, string>();
for (const row of rows) {
  const [zip, state] = row.split(",");
  zipToState.set(zip!, state!);
}
for (const [zip, state] of [...zipToState].sort(([a], [b]) => (a < b ? -1 : 1))) (byState[state] ??= []).push(zip);

const out = `${JSON.stringify(Object.fromEntries(Object.entries(byState).sort(([a], [b]) => (a < b ? -1 : 1)).map(([state, zips]) => [state, zips.join(" ")])))}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(OUT_PATH, "utf8") !== out) {
    console.error("us-zip-states.generated.json is stale: run node scripts/generate-us-zip-states.ts");
    process.exit(1);
  }
} else writeFileSync(OUT_PATH, out);
