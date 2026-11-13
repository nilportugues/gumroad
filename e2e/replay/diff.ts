import { maskLocation, maskPath } from "./mask.ts";
import type { ReplayedExchange } from "./replay.ts";

export type Difference = { key: string; field: string; a: unknown; b: unknown };

export type DiffReport = {
  paired: number;
  skipped: number;
  onlyInA: string[];
  onlyInB: string[];
  differences: Difference[];
  byField: Record<string, number>;
};

// Keyed by position, not by path: ids in paths differ per server, but the Nth exchange of a step is the same request;
// a path that still differs after masking is reported as a difference of its own.
const keyed = (exchanges: ReplayedExchange[]) => {
  const counters = new Map<string, number>();
  return exchanges.map((exchange) => {
    const base = `${exchange.session}/${exchange.actor}/${exchange.step}/${exchange.method}`;
    const n = (counters.get(base) ?? 0) + 1;
    counters.set(base, n);
    return { key: `${base}#${n}`, exchange };
  });
};

const HEADER_FIELDS = ["content-type", "x-inertia", "cache-control", "vary", "content-disposition"] as const;

const fields = (exchange: ReplayedExchange): Record<string, unknown> => ({
  status: exchange.status,
  path: maskPath(exchange.path),
  location:
    exchange.responseHeaders.location === undefined ? undefined : maskLocation(exchange.responseHeaders.location),
  ...Object.fromEntries(HEADER_FIELDS.map((name) => [name, exchange.responseHeaders[name]])),
  // Cookie values are never recorded; names are compared as a set.
  "set-cookie names": [...exchange.setCookieNames].sort().join(","),
  // The masked hash when both sides have one; the raw hash otherwise (it will rarely agree).
  body: exchange.normalizedBodyHash ?? exchange.responseBodyHash,
});

/** Compares two replay outputs exchange by exchange. Exchanges skipped on either side are counted, not compared. */
export const diffReplays = (a: ReplayedExchange[], b: ReplayedExchange[]): DiffReport => {
  const report: DiffReport = { paired: 0, skipped: 0, onlyInA: [], onlyInB: [], differences: [], byField: {} };
  const right = new Map(keyed(b).map(({ key, exchange }) => [key, exchange]));

  for (const { key, exchange } of keyed(a)) {
    const other = right.get(key);
    if (!other) {
      report.onlyInA.push(key);
      continue;
    }
    right.delete(key);
    if (exchange.replay?.skipped || other.replay?.skipped) {
      report.skipped += 1;
      continue;
    }
    report.paired += 1;
    const rightFields = fields(other);
    for (const [field, value] of Object.entries(fields(exchange))) {
      if (value !== rightFields[field]) {
        report.differences.push({ key, field, a: value, b: rightFields[field] });
        report.byField[field] = (report.byField[field] ?? 0) + 1;
      }
    }
  }
  report.onlyInB = [...right.keys()];
  return report;
};

export const isClean = (report: DiffReport) =>
  report.differences.length === 0 && report.onlyInA.length === 0 && report.onlyInB.length === 0;

export const formatReport = (report: DiffReport) => {
  const lines = [
    `paired ${report.paired}, skipped ${report.skipped}, only in A ${report.onlyInA.length}, only in B ${report.onlyInB.length}, differences ${report.differences.length}`,
  ];
  for (const [field, count] of Object.entries(report.byField).sort()) lines.push(`  ${field}: ${count}`);
  for (const d of report.differences)
    lines.push(`DIFF ${d.key} [${d.field}] A=${JSON.stringify(d.a)} B=${JSON.stringify(d.b)}`);
  for (const key of report.onlyInA) lines.push(`ONLY-A ${key}`);
  for (const key of report.onlyInB) lines.push(`ONLY-B ${key}`);
  return lines.join("\n");
};
