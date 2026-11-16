import { readFileSync } from "node:fs";

import type { RecordedExchange } from "./recorder";

// Segments that carry per-run identifiers (permalinks, external ids, tokens) are masked; the shape of the path stays.
const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9_=%+-]{6,}$/u;
const maskPath = (rawPath: string) => {
  const url = new URL(rawPath, "http://trace.invalid");
  const segments = url.pathname.split("/").map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment));
  const queryKeys = [...new Set(url.searchParams.keys())].sort().join("&");
  return `${segments.join("/")}${queryKeys ? `?${queryKeys}` : ""}`;
};

/**
 * Reduces a recorder JSONL file to the navigations a bot run made: per bot step, the sorted method + masked path
 * of each document request. Background XHRs (cart count, surcharge, tokens) are left out because they finish
 * after the step that started them and land on a neighbouring step from run to run.
 */
export const requestSequence = (file: string): string[] => {
  const exchanges = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): RecordedExchange => JSON.parse(line));
  const steps = new Map<string, string[]>();
  for (const exchange of exchanges) {
    if (exchange.resourceType !== "document") continue;
    const key = `${exchange.session}#${String(exchange.step).padStart(4, "0")} ${exchange.actor} ${exchange.action}`;
    const requests = steps.get(key) ?? [];
    requests.push(`${exchange.method} ${maskPath(exchange.path)}`);
    steps.set(key, requests);
  }
  return [...steps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, requests]) => `${key}: ${requests.sort().join(" | ")}`);
};
