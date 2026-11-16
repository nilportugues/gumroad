// Replays a golden written by generate-html-golden.rb against the Node ports and reports every
// mismatch. The committed golden runs in html.test.ts; this is for larger fuzz runs:
//
//   bundle exec ruby nextjs/src/server/html/__fixtures__/generate-html-golden.rb 7 20000 /tmp/fuzz.json
//   node nextjs/src/server/html/__fixtures__/fuzz-html.ts /tmp/fuzz.json
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { checks } from "./html-checks.ts";
import type { HtmlGolden } from "./html-golden.ts";

const golden = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as HtmlGolden;
const failures = new Map<string, number>();
let shown = 0;
for (const [index, c] of golden.cases.entries()) {
  for (const check of checks) {
    let actual: unknown;
    try {
      actual = check.actual(c);
    } catch (error) {
      actual = { thrown: String(error) };
    }
    const expected = check.expected(c);
    if (isDeepStrictEqual(actual, expected)) continue;
    failures.set(check.name, (failures.get(check.name) ?? 0) + 1);
    if (shown++ < Number(process.env.SHOW ?? 5)) {
      console.log(`--- case ${index} ${check.name}\ninput:    ${JSON.stringify(check.input(c))}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
    }
  }
}
console.log(`${golden.cases.length} cases (seed ${golden.seed}), ${checks.length} checks each`);
for (const check of checks) console.log(`${check.name}: ${failures.get(check.name) ?? 0} mismatches`);
process.exitCode = failures.size > 0 ? 1 : 0;
