// Generates src/server/jobs/registry.generated.ts (and the JSON list of Node-owned jobs that the
// Rails bridge reads) from app/sidekiq and config/sidekiq_schedule.yml.
// Run: node scripts/generate-job-registry.ts [--check]
//
// Ruby is parsed, not executed: the generator understands the literal forms app/sidekiq actually
// uses in sidekiq_options and recurring_lock_ttl, and fails on anything else rather than guess.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { CronExpressionParser } from "cron-parser";
import { format, resolveConfig } from "prettier";
import { parse as parseYaml } from "yaml";

import { LOCK_ARGS } from "../src/server/jobs/lock-args.ts";
import { PORTED_JOBS } from "../src/server/jobs/ported-jobs.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
// app/jobs is mostly ActiveJob, but holds the odd plain Sidekiq::Job; ActiveJob classes go
// through Sidekiq::ActiveJob::Wrapper with a different payload and are not in the registry.
const JOB_DIRS = ["app/sidekiq", "app/jobs"];
const schedulePath = join(repoRoot, "config/sidekiq_schedule.yml");
const outTs = resolve(import.meta.dirname, "../src/server/jobs/registry.generated.ts");
const outJson = resolve(import.meta.dirname, "../src/server/jobs/node-owned-jobs.generated.json");

type Value = string | number | boolean | null | { [key: string]: Value };

type JobEntry = {
  file: string;
  aliasOf?: string;
  sidekiqJob: boolean;
  options: Record<string, Value>;
  customLockArgs: boolean;
  customRetryIn: boolean;
  retriesExhausted: boolean;
  recurringLockMaxAttempt?: number;
  runtime: "ruby" | "node";
};

type CronEntry = { name: string; cron: string; class: string; queue?: string; args?: unknown[]; description?: string };

const DURATION_UNITS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };

// Drops a trailing `# comment`, ignoring `#` inside string literals and `#{}` interpolation.
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function constantsOf(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/^\s*([A-Z][A-Z0-9_]*) = (.+)$/gmu))
    constants.set(match[1]!, stripComment(match[2]!).trim());
  return constants;
}

// Integer seconds for `6.hours.to_i`, `LOCK_TTL.to_i`, `SCAN_TIME_BUDGET + 1.hour`, `900`.
function evaluateInteger(expression: string, constants: Map<string, string>, file: string): number {
  const terms = splitTopLevel(expression.replace(/\.to_i$/u, ""), "+");
  return terms.reduce((sum, rawTerm) => {
    const term = rawTerm.replace(/\.to_i$/u, "").replaceAll("_", "");
    const literal = term.match(/^\d+$/u);
    if (literal) return sum + Number(term);
    const duration = rawTerm.match(/^(\d+)\.(second|minute|hour|day|week)s?(\.to_i)?$/u);
    if (duration) return sum + Number(duration[1]) * DURATION_UNITS[duration[2]!]!;
    const constant = rawTerm.replace(/\.to_i$/u, "");
    const definition = constants.get(constant);
    if (definition !== undefined) return sum + evaluateInteger(definition, constants, file);
    throw new Error(`${file}: cannot evaluate \`${rawTerm}\``);
  }, 0);
}

function parseValue(raw: string, constants: Map<string, string>, file: string): Value {
  const text = raw.trim();
  if (text.startsWith(":")) return text.slice(1);
  if (/^"[^"#]*"$/u.test(text) || /^'[^']*'$/u.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "nil") return null;
  if (text.startsWith("{") && text.endsWith("}")) return parsePairs(text.slice(1, -1), constants, file);
  return evaluateInteger(text, constants, file);
}

function parsePairs(text: string, constants: Map<string, string>, file: string): Record<string, Value> {
  const result: Record<string, Value> = {};
  for (const pair of splitTopLevel(text, ",")) {
    const match = pair.match(/^(?:(\w+):|["'](\w+)["']\s*=>)\s*(.+)$/su);
    if (!match) throw new Error(`${file}: cannot parse option \`${pair}\``);
    result[match[1] ?? match[2]!] = parseValue(match[3]!, constants, file);
  }
  return result;
}

// Collects `sidekiq_options ...` and `recurring_lock_ttl ...` calls in source order, following
// continuation lines that end in `,` or leave a bracket open.
type Statement = { keyword: "sidekiq_options" | "recurring_lock_ttl"; text: string };

function statements(source: string): Statement[] {
  const found: Statement[] = [];
  const lines = source.split("\n").map(stripComment);
  const balance = (s: string) =>
    [...s].reduce((n, ch) => n + ("{[(".includes(ch) ? 1 : "}])".includes(ch) ? -1 : 0), 0);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^\s*(sidekiq_options|recurring_lock_ttl)\b\(?\s*(.*)$/u);
    if (!head) continue;
    let text = head[2]!.trim();
    while ((text.endsWith(",") || balance(text) > 0) && i + 1 < lines.length) text += ` ${lines[++i]!.trim()}`;
    if (balance(text) < 0 && text.endsWith(")")) text = text.slice(0, -1);
    found.push({ keyword: head[1] as Statement["keyword"], text: text.trim() });
  }
  return found;
}

// Sidekiq::Cron::Job#parse_args: a string is JSON if it parses, otherwise one argument.
function cronArgs(args: unknown): unknown[] {
  if (Array.isArray(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [args];
    }
  }
  return [args];
}

function loadSchedule(): CronEntry[] {
  const raw = parseYaml(readFileSync(schedulePath, "utf8")) as Record<string, Record<string, unknown>>;
  return Object.entries(raw).map(([name, entry]) => ({
    name,
    cron: String(entry.cron),
    class: String(entry.class),
    ...(entry.queue === undefined ? {} : { queue: String(entry.queue) }),
    ...(entry.args === undefined || entry.args === null ? {} : { args: cronArgs(entry.args) }),
    ...(entry.description === undefined ? {} : { description: String(entry.description) }),
  }));
}

// app/models/concerns/recurring_lock_ttl.rb, line for line; recurring-lock-ttl.golden.json pins it.
const SAFETY_MARGIN = 5 * 60;
const ATTEMPT_MULTIPLE = 3;
const SAMPLES = 12;

function intervalOf(cron: string): number {
  const parsed = CronExpressionParser.parse(cron, { currentDate: new Date(Date.UTC(2026, 0, 5)), tz: "UTC" });
  let cursor = parsed.next().getTime();
  const gaps: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const next = parsed.next().getTime();
    gaps.push((next - cursor) / 1000);
    cursor = next;
  }
  return Math.min(...gaps);
}

export function recurringLockTtl(className: string, maxAttempt: number, schedule: CronEntry[]): number {
  const floor = maxAttempt + SAFETY_MARGIN;
  const crons = schedule.filter((entry) => entry.class === className).map((entry) => entry.cron);
  const interval = crons.length ? Math.min(...crons.map(intervalOf)) : null;
  const ceiling = interval === null ? floor : Math.max(interval - SAFETY_MARGIN, floor);
  return Math.min(Math.max(Math.max(maxAttempt * ATTEMPT_MULTIPLE, floor), floor), ceiling);
}

function jobFiles(): string[] {
  return JOB_DIRS.flatMap((dir) =>
    (readdirSync(join(repoRoot, dir), { recursive: true }) as string[])
      .filter((file) => file.endsWith(".rb") && !file.startsWith("concerns/"))
      .map((file) => `${dir}/${file}`)
      .filter(
        (relative) =>
          dir === "app/sidekiq" ||
          /^\s*include Sidekiq::(Job|Worker)\b/mu.test(readFileSync(join(repoRoot, relative), "utf8")),
      ),
  ).sort();
}

// `class A::B`, or `class B` nested in `module A`.
function classNameOf(source: string): string | undefined {
  const modules = [...source.matchAll(/^\s*module ([\w:]+)\s*$/gmu)].map((match) => match[1]);
  const className = source.match(/^\s*class ([\w:]+)/mu)?.[1];
  return className && [...modules, className].join("::");
}

function parseJobFile(relative: string, schedule: CronEntry[]): [string, JobEntry] {
  const source = readFileSync(join(repoRoot, relative), "utf8");
  const constants = constantsOf(source);
  const className = classNameOf(source);

  if (!className) {
    const alias = source.match(/^(\w+) = (\w+)\s*$/mu);
    if (!alias) throw new Error(`${relative}: no class or alias found`);
    const entry: JobEntry = {
      file: relative,
      aliasOf: alias[2]!,
      sidekiqJob: true,
      options: {},
      customLockArgs: false,
      customRetryIn: false,
      retriesExhausted: false,
      runtime: "ruby",
    };
    return [alias[1]!, entry];
  }

  // Options merge in source order, as successive `sidekiq_options` calls do in Ruby; the key
  // order is the payload's key order.
  const options: Record<string, Value> = {};
  let recurringLockMaxAttempt: number | undefined;
  for (const statement of statements(source)) {
    const pairs = parsePairs(statement.text, constants, relative);
    if (statement.keyword === "sidekiq_options") Object.assign(options, pairs);
    else {
      recurringLockMaxAttempt = pairs.max_attempt as number;
      options.lock_ttl = recurringLockTtl(className, recurringLockMaxAttempt, schedule);
    }
  }

  const entry: JobEntry = {
    file: relative,
    sidekiqJob: /^\s*include Sidekiq::(Job|Worker)\b/mu.test(source),
    options,
    customLockArgs: /^\s*def self\.lock_args\b/mu.test(source),
    customRetryIn: /^\s*sidekiq_retry_in\b/mu.test(source),
    retriesExhausted:
      /^\s*sidekiq_retries_exhausted\b/mu.test(source) || /^\s*include FinanceReportFailureAlert\b/mu.test(source),
    ...(recurringLockMaxAttempt === undefined ? {} : { recurringLockMaxAttempt }),
    runtime: PORTED_JOBS.includes(className) ? "node" : "ruby",
  };
  return [className, entry];
}

export function buildRegistry() {
  const schedule = loadSchedule();
  const jobs = Object.fromEntries(jobFiles().map((file) => parseJobFile(file, schedule)));

  const problems: string[] = [];
  for (const [name, entry] of Object.entries(jobs)) {
    if (entry.aliasOf && !jobs[entry.aliasOf]) problems.push(`${name} aliases unknown ${entry.aliasOf}`);
    if (entry.customLockArgs && !LOCK_ARGS[name])
      problems.push(`${name} defines self.lock_args; port it to src/server/jobs/lock-args.ts`);
  }
  for (const name of Object.keys(LOCK_ARGS))
    if (!jobs[name]?.customLockArgs) problems.push(`lock-args.ts has ${name}, which defines no lock_args in Ruby`);
  for (const name of PORTED_JOBS)
    if (!jobs[name] || jobs[name].aliasOf) problems.push(`ported-jobs.ts lists ${name}, which is not a job class`);
  for (const entry of schedule)
    if (!jobs[entry.class]) problems.push(`cron entry ${entry.name} runs unknown class ${entry.class}`);
  if (problems.length) throw new Error(`Job registry problems:\n  ${problems.join("\n  ")}`);

  return { jobs, schedule };
}

// Format with the repo prettier config so the file passes eslint's prettier/prettier rule as written.
async function formatTs(source: string): Promise<string> {
  const config = await resolveConfig(outTs);
  return format(source, { ...config, filepath: outTs });
}

async function render(): Promise<{ ts: string; json: string }> {
  const { jobs, schedule } = buildRegistry();
  const queues = [
    ...new Set([
      "default",
      ...Object.values(jobs).map((job) => String(job.options.queue ?? "default")),
      ...schedule.flatMap((e) => (e.queue ? [e.queue] : [])),
    ]),
  ].sort();
  const ts = `// Generated by scripts/generate-job-registry.ts from app/sidekiq and config/sidekiq_schedule.yml.
// Do not edit; run \`npm run jobs:generate\`. \`npm run jobs:check-drift\` fails CI when this is stale.
import type { JobDefinition, CronDefinition } from "./registry-types.ts";

export const JOB_REGISTRY = ${JSON.stringify(jobs, null, 2)} as const satisfies Record<string, JobDefinition>;

export type JobClass = keyof typeof JOB_REGISTRY;

export const SIDEKIQ_QUEUES = ${JSON.stringify(queues)} as const;

export const CRON_SCHEDULE: readonly CronDefinition[] = ${JSON.stringify(schedule, null, 2)};
`;
  const nodeOwned = Object.entries(jobs)
    .filter(([, entry]) => entry.runtime === "node")
    .map(([name]) => name);
  return { ts: await formatTs(ts), json: `${JSON.stringify(nodeOwned, null, 2)}\n` };
}

if (import.meta.main) {
  const { ts, json } = await render();
  if (process.argv.includes("--check")) {
    const stale = [
      [outTs, ts],
      [outJson, json],
    ].filter(([path, content]) => readFileSync(path!, "utf8") !== content);
    if (stale.length) {
      console.error(`Stale: ${stale.map(([path]) => basename(path!)).join(", ")}. Run \`npm run jobs:generate\`.`);
      process.exit(1);
    }
  } else {
    writeFileSync(outTs, ts);
    writeFileSync(outJson, json);
    // eslint-disable-next-line no-console -- CLI output
    console.log(`Wrote ${basename(outTs)} and ${basename(outJson)}`);
  }
}
