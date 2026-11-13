// Usage: node e2e/replay/compare-cli.ts <recording.jsonl> <rails-url> <node-url> <out-dir>
// Replays one recording against both servers (Rails first, then Node, on the same database), writes
// <out-dir>/replay-rails.jsonl, replay-node.jsonl, report.json and report.md. Exit 0 when they agree after masking, 1 when not.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { diffReplays, formatMarkdown, isClean } from "./diff.ts";
import { readRecording, replay, writeRecording } from "./replay.ts";

const [input, railsUrl, nodeUrl, outDir] = process.argv.slice(2);
if (!input || !railsUrl || !nodeUrl || !outDir) {
  process.stderr.write("usage: node e2e/replay/compare-cli.ts <recording.jsonl> <rails-url> <node-url> <out-dir>\n");
  process.exit(2);
}

try {
  mkdirSync(outDir, { recursive: true });
  const recording = readRecording(input);
  const rails = await replay(recording, railsUrl);
  writeRecording(path.join(outDir, "replay-rails.jsonl"), rails);
  const node = await replay(recording, nodeUrl);
  writeRecording(path.join(outDir, "replay-node.jsonl"), node);
  const report = diffReplays(rails, node);
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = formatMarkdown(report, { a: "Rails", b: "Node" });
  writeFileSync(path.join(outDir, "report.md"), `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
  process.exit(isClean(report) ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
