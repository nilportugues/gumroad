// Usage: node e2e/replay/diff-cli.ts <replay-a.jsonl> <replay-b.jsonl> [--json]
// Exit code 0 when the two replays agree after masking, 1 when they differ, 2 on bad input.
import { diffReplays, formatReport, isClean } from "./diff.ts";
import { readRecording } from "./replay.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const [a, b] = args.filter((arg) => arg !== "--json");
if (!a || !b) {
  process.stderr.write("usage: node e2e/replay/diff-cli.ts <replay-a.jsonl> <replay-b.jsonl> [--json]\n");
  process.exit(2);
}

try {
  const report = diffReplays(readRecording(a), readRecording(b));
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
  process.exit(isClean(report) ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
