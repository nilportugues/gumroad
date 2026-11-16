// Mechanical migration for #8928: Rails dropped the `user` group (`view_store_agent`, `use_store_agent`) from the shared
// `policies` props, so a recorded response carries a group the current Rails no longer sends. Removing it from fixtures
// recorded before that is exactly what a fresh recording changes in the response; every other channel is untouched. Do not
// run it on a fixture whose Rails side changed for another reason: re-record those.
//
//   node scripts/drop-store-agent-policies.ts            rewrite fixtures in place
//   node scripts/drop-store-agent-policies.ts --check    exit 1 and list fixtures that still carry the group
import assert from "node:assert";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../parity/fixtures");
const DROPPED_KEYS = ["view_store_agent", "use_store_agent"];

// Edit the text, not the parsed value: re-serialising would turn Ruby's `0.0` into `0` all over the corpus. The group is
// removed together with its comma; the result is checked against the parsed original with the group deleted.
const GROUP = String.raw`"user": \{(?:\s*(?:"(?:view_store_agent|use_store_agent)": (?:true|false),?\s*){2})?\}`;
const MIDDLE = new RegExp(String.raw`${GROUP},\s*`, "gu");
const LAST = new RegExp(String.raw`,\s*${GROUP}`, "gu");

function withoutGroup(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutGroup);
  if (node === null || typeof node !== "object") return node;
  const entries = Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, withoutGroup(v)] as const);
  const record = Object.fromEntries(entries);
  const policies = record.policies as Record<string, unknown> | undefined;
  if (policies !== undefined && typeof policies === "object" && policies !== null) delete policies.user;
  return record;
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
const unhandled: string[] = [];
for (const file of fixtureFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  if (!DROPPED_KEYS.some((key) => text.includes(key)) && !text.includes('"user": {}')) continue;
  const rewritten = text.replace(MIDDLE, "").replace(LAST, "");
  const name = path.relative(ROOT, file);
  if (rewritten === text) continue;
  try {
    assert.deepStrictEqual(JSON.parse(rewritten), withoutGroup(JSON.parse(text)));
  } catch {
    unhandled.push(name);
    continue;
  }
  stale.push(name);
  if (!check) writeFileSync(file, rewritten);
}
console.log(`${check ? "still carry" : "rewrote"} ${stale.length} fixtures`);
if (unhandled.length > 0) console.log(`keys left in a shape this script does not know:\n${unhandled.join("\n")}`);
if ((check && stale.length > 0) || unhandled.length > 0) process.exit(1);
