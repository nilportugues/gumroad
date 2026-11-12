// Lists the Ruby request/controller examples tagged `parity: true` that have no recorded fixture in
// nextjs/parity/fixtures, per spec file.
// Run from nextjs/: node scripts/parity-debt.ts [--json] [--spec <path-substring>]
//
// Ruby is parsed, not executed (this runs without a Ruby install). The spec files are
// rubocop-formatted, so the nesting of describe/context/it blocks is read from indentation, and an
// example matches a fixture when its reconstructed full description equals the fixture's recorded
// `example` field (same spec file). What it cannot resolve is reported, not guessed:
//   dynamic   the description has `#{}` interpolation or a `describe some_variable` loop; matched as a pattern,
//             and listed under "unresolved" when no fixture matches the pattern
//   shared    the example sits inside shared_examples, so its real name depends on the includer
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const FIXTURES_DIR = join(repoRoot, "nextjs/parity/fixtures");
const HOLE = "\u0000";

type Part = { text: string; module: boolean; dynamic: boolean };
type Node = { indent: number; kind: string; part: Part | null; tagged: boolean };
type Example = { spec: string; line: number; name: string; dynamic: boolean; shared: boolean; regex: RegExp };

const GROUP =
  /^(\s*)(?:RSpec\.)?(describe|context|feature|shared_examples|shared_examples_for|shared_context|it_behaves_like|it_should_behave_like|include_examples|include_context|it|specify|example|scenario)\b[\s(]*(.*)$/u;
const EXAMPLE_KINDS = ["it", "specify", "example", "scenario"];

function readDescription(rest: string): Part | null {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") {
    const constant = /^([A-Z][\w:]*)/u.exec(rest);
    if (constant) return { text: constant[1] ?? "", module: true, dynamic: false };
    // `describe provider do` inside a loop: the description is a variable, so it is a hole like an interpolation.
    return /^[a-z_]\w*(?:\s+do\b|\s*,|\s*\)|\s*$)/u.test(rest) ? { text: HOLE, module: false, dynamic: true } : null;
  }
  let text = "";
  let dynamic = false;
  for (let i = 1; i < rest.length && rest[i] !== quote; i++) {
    if (rest[i] === "\\" && i + 1 < rest.length) {
      i++;
      text += rest[i] === "n" ? "\n" : rest[i];
    } else if (quote === '"' && rest[i] === "#" && rest[i + 1] === "{") {
      let depth = 0;
      i++;
      do {
        if (rest[i] === "{") depth++;
        if (rest[i] === "}") depth--;
        i++;
      } while (depth > 0 && i < rest.length);
      i--;
      text += HOLE;
      dynamic = true;
    } else text += rest[i];
  }
  return { text, module: false, dynamic };
}

// RSpec joins with a space, except that a `#method`, `.method` or `::Const` child follows a class directly.
function fullDescription(parts: Part[]): string {
  return parts.reduce((name, part, i) => {
    if (i === 0) return part.text;
    return name + (parts[i - 1]?.module && /^(#|::|\.)/u.test(part.text) ? "" : " ") + part.text;
  }, "");
}

function toRegex(name: string): RegExp {
  const escaped = name.split(HOLE).map((s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^${escaped.join(".+?")}$`, "su");
}

function parseSpec(path: string, spec: string): Example[] {
  const stack: Node[] = [];
  const examples: Example[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((text, index) => {
      const match = GROUP.exec(text);
      if (!match) return;
      const [, ws = "", kind = "", rest = ""] = match;
      const indent = ws.length;
      while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop();
      const part = readDescription(rest.trimStart());
      const tagged = /\bparity:\s*true\b/u.test(text);
      if (EXAMPLE_KINDS.includes(kind)) {
        if (!tagged && !stack.some((n) => n.tagged)) return;
        const parts = [...stack.map((n) => n.part), part].filter((p): p is Part => p !== null);
        const name = fullDescription(parts);
        examples.push({
          spec,
          line: index + 1,
          name,
          dynamic: parts.some((p) => p.dynamic),
          shared: stack.some((n) => n.kind.startsWith("shared_")),
          regex: toRegex(name),
        });
        return;
      }
      const includes = kind.startsWith("include") || kind.startsWith("it_");
      stack.push({ indent, kind, part: includes ? null : part, tagged });
    });
  return examples;
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, accept) : accept(entry) ? [full] : [];
  });
}

function main() {
  const args = process.argv.slice(2);
  const filter = args.includes("--spec") ? (args[args.indexOf("--spec") + 1] ?? "") : "";
  const fixtures = new Map<string, string[]>();
  for (const file of walk(FIXTURES_DIR, (n) => n.endsWith(".json"))) {
    const { spec, example } = JSON.parse(readFileSync(file, "utf8")) as { spec: string; example: string };
    fixtures.set(spec, [...(fixtures.get(spec) ?? []), example]);
  }

  const specs = walk(join(repoRoot, "spec"), (n) => n.endsWith("_spec.rb"))
    .map((path) => relative(repoRoot, path))
    .filter((path) => path.includes(filter));
  const report: Record<string, { tagged: number; recorded: number; missing: Example[]; unresolved: Example[] }> = {};
  for (const spec of specs) {
    if (!/parity:\s*true/u.test(readFileSync(join(repoRoot, spec), "utf8"))) continue;
    const recorded = fixtures.get(spec) ?? [];
    const examples = parseSpec(join(repoRoot, spec), spec);
    const missing: Example[] = [];
    const unresolved: Example[] = [];
    for (const example of examples) {
      if (example.shared) unresolved.push(example);
      else if (!recorded.some((r) => (example.dynamic ? example.regex.test(r) : r === example.name)))
        (example.dynamic ? unresolved : missing).push(example);
    }
    report[spec] = { tagged: examples.length, recorded: recorded.length, missing, unresolved };
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  let tagged = 0;
  let missing = 0;
  let unresolved = 0;
  for (const [spec, entry] of Object.entries(report)) {
    tagged += entry.tagged;
    missing += entry.missing.length;
    unresolved += entry.unresolved.length;
    if (entry.missing.length === 0 && entry.unresolved.length === 0) continue;
    console.log(
      `${spec}: ${entry.tagged} tagged, ${entry.recorded} fixtures, ${entry.missing.length} without a fixture, ${entry.unresolved.length} unresolved`,
    );
    for (const e of entry.missing) console.log(`  missing     :${e.line} ${e.name}`);
    for (const e of entry.unresolved) console.log(`  unresolved  :${e.line} ${e.name.replaceAll(HOLE, "#{...}")}`);
  }
  console.log(
    `\n${Object.keys(report).length} spec files, ${tagged} tagged examples, ${missing} without a fixture, ${unresolved} unresolved`,
  );
}

main();
