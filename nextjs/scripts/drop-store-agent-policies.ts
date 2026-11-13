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

// Edit the text, not the parsed value: re-serialising would turn Ruby's `0.0` into `0` all over the corpus. `policies.user`
// held exactly these two keys, so the block becomes `{}`, as Rails now renders it.
const USER_POLICIES = /"user": \{\s*"(view_store_agent|use_store_agent)": (?:true|false),\s*"(?:view_store_agent|use_store_agent)": (?:true|false)\s*\}/gu;

function* fixtureFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* fixtureFiles(full);
    else if (entry.name.endsWith(".json")) yield full;
  }
}

const check = process.argv.includes("--check");
const stale: string[] = [];
const unhandled: string[] = [];
for (const file of fixtureFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  if (!DROPPED_KEYS.some((key) => text.includes(key))) continue;
  const rewritten = text.replace(USER_POLICIES, '"user": {}');
  const name = path.relative(ROOT, file);
  if (DROPPED_KEYS.some((key) => rewritten.includes(key))) unhandled.push(name);
  stale.push(name);
  if (!check) writeFileSync(file, rewritten);
}
console.log(`${check ? "still carry" : "rewrote"} ${stale.length} fixtures`);
if (unhandled.length > 0) console.log(`keys left in a shape this script does not know:\n${unhandled.join("\n")}`);
if ((check && stale.length > 0) || unhandled.length > 0) process.exit(1);
