// Compares the current `npm run lint` rule counts with lint-baseline.json so new code can be shown to
// add no violations while the existing backlog is paid down. `--write` regenerates the file.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE_PATH = new URL("../lint-baseline.json", import.meta.url);
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

type EslintFile = { messages: { ruleId: string | null }[] };

// Untyped lint: the typed rules need a full program build and add minutes; the backlog is tracked per rule
// either way. cwd is pinned so `node scripts/lint-baseline.ts` works from anywhere.
const result = spawnSync("../node_modules/.bin/eslint", [".", "--format", "json"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  encoding: "utf8",
  env: { ...process.env, DISABLE_TYPE_CHECKED: "1" },
  maxBuffer: MAX_OUTPUT_BYTES,
});
if (!result.stdout) throw new Error(`eslint produced no JSON report: ${result.stderr || result.error?.message}`);
const report = JSON.parse(result.stdout) as EslintFile[];
const counts: Record<string, number> = {};
for (const file of report)
  for (const { ruleId } of file.messages) counts[ruleId ?? "parse-error"] = (counts[ruleId ?? "parse-error"] ?? 0) + 1;
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

if (process.argv.includes("--write")) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stdout.write(`Wrote ${Object.keys(sorted).length} rules to lint-baseline.json\n`);
} else {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
  const regressions = Object.entries(sorted).filter(([rule, n]) => n > (baseline[rule] ?? 0));
  for (const [rule, n] of regressions) process.stderr.write(`${rule}: ${n} (baseline ${baseline[rule] ?? 0})\n`);
  if (regressions.length > 0) process.exit(1);
  process.stdout.write(`No rule exceeds its baseline count.\n`);
}
