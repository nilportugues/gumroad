// Usage: node e2e/replay/replay-cli.ts <recording.jsonl> <base-url> <output.jsonl>
import { readRecording, replay, writeRecording } from "./replay.ts";

const [input, baseUrl, output] = process.argv.slice(2);
if (!input || !baseUrl || !output) {
  process.stderr.write("usage: node e2e/replay/replay-cli.ts <recording.jsonl> <base-url> <output.jsonl>\n");
  process.exit(2);
}

try {
  const results = await replay(readRecording(input), baseUrl);
  writeRecording(output, results);
  const skipped = results.filter((result) => result.replay?.skipped).length;
  process.stderr.write(
    `replayed ${results.length - skipped} of ${results.length} exchanges (${skipped} skipped) -> ${output}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
