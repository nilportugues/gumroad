// tsc over the Next.js program, failing only on errors in nextjs/. The shared components a converted
// page imports from app/javascript are written against React 18's types and the Rails tsconfig's
// whole-directory ambient declarations; the root `npm run typecheck` is what checks them. Here they
// compile against React 19's types, which the App Router requires, so their errors are listed, not fatal.
import { spawnSync } from "node:child_process";

const result = spawnSync("./node_modules/.bin/tsc", ["--noEmit", "-p", "."], { encoding: "utf8" });
const lines = `${result.stdout}${result.stderr}`.split("\n");
const errors = lines.filter((line) => / error TS\d+:/.test(line));
const shared = errors.filter((line) => line.startsWith("../app/javascript/"));
const own = errors.filter((line) => !line.startsWith("../app/javascript/"));

if (shared.length > 0) console.log(`${shared.length} type errors in app/javascript under React 19's types (checked by the root typecheck).`);
if (own.length > 0) {
  console.error(own.join("\n"));
  process.exit(1);
}
if (result.status !== 0 && errors.length === 0) {
  console.error(lines.join("\n"));
  process.exit(result.status ?? 1);
}
