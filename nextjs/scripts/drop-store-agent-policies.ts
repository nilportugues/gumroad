// Mechanical migration for #8928: Rails dropped `policies.user.view_store_agent` and `use_store_agent` from the
// shared props, so a recorded response carries two keys the current Rails no longer sends. Removing them from
// fixtures recorded before that is exactly what a fresh recording would change in the response; every other
// channel is untouched. Do not run it on a fixture whose Rails side changed for another reason: re-record those.
//
//   node scripts/drop-store-agent-policies.ts            rewrite fixtures in place
//   node scripts/drop-store-agent-policies.ts --check    exit 1 and list fixtures that still carry the keys
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../parity/fixtures");
const DROPPED_KEYS = ["view_store_agent", "use_store_agent"];

function strip(node: unknown): boolean {
  let changed = false;
  if (Array.isArray(node)) {
    for (const item of node) changed = strip(item) || changed;
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const user = (record.policies as Record<string, unknown> | undefined)?.user;
    if (user !== null && typeof user === "object") {
      for (const key of DROPPED_KEYS) {
        if (key in (user as object)) {
          delete (user as Record<string, unknown>)[key];
          changed = true;
        }
      }
    }
    for (const value of Object.values(record)) changed = strip(value) || changed;
  }
  return changed;
}

function* fixtureFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* fixtureFiles(full);
    else if (entry.name.endsWith(".json")) yield full;
  }
}

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const file of fixtureFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  if (!DROPPED_KEYS.some((key) => text.includes(key))) continue;
  const fixture: unknown = JSON.parse(text);
  if (!strip(fixture)) continue;
  stale.push(path.relative(ROOT, file));
  if (!check) writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}
console.log(`${check ? "still carry" : "rewrote"} ${stale.length} fixtures`);
if (check && stale.length > 0) {
  console.log(stale.join("\n"));
  process.exit(1);
}
