// Replays stale-transient-suppression-sweep-job.golden.json (scripts/golden/stale-transient-suppression-sweep-job.rb):
// StaleTransientSuppressionSweepJob run by the real app as a Sidekiq job with every outbound request answered by WebMock. Node makes
// the SendGrid requests Rails made (URL, window, paging, Authorization) and finishes when no list holds an entry with an email; it hands
// back, after the same requests, a list with a usable entry and a request or body Rails notifies on.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import {
  staleTransientSuppressionSweepJobWith,
  type SuppressionFetch,
} from "./stale-transient-suppression-sweep-job.ts";

type Http = { method: string; url: string; headers: Record<string, string> };
type Case = {
  name: string;
  error: { class: string; message: string } | null;
  http: Http[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stale-transient-suppression-sweep-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Rails notifies and moves on from these; Node hands them back instead.
const NODE_HANDS_BACK = new Set([
  "a bounce list with a failing status",
  "a bounce list that is not an array",
  "a bounce list that is not JSON",
  "a bounce list with a server error then empty blocks",
  "a full first page with usable entries",
]);
// The keys the recording set, in EmailSuppressionManager.subuser_api_keys order.
const SUBUSERS = ["gumroad", "followers", "creators", "customers_level_1", "customers_level_2"];

// Answers each request from what WebMock was told to answer the same request with: the golden records the requests, and the bodies
// are the ones the generator queued (an empty list unless the case says otherwise).
function answersFor(c: Case): Response[] {
  const body = (value: unknown, status = 200) =>
    new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
  const usable = [{ created: 1, email: "bounced0@example.com", reason: "mailbox full" }];
  switch (c.name) {
    case "a bounce list with a usable entry":
      return [body(usable)];
    case "a block list with a usable entry after an empty bounce list":
      return [body([]), body(usable)];
    case "a bounce list with entries that have no email":
      return [
        body([
          { created: 1, email: "", reason: "x" },
          { created: 1, reason: "y" },
        ]),
        body([]),
      ];
    case "a bounce list with entries that are not hashes":
      return [body(["a@example.com", 5, null]), body([])];
    case "a full first page of entries without an email":
      return [body(blankPage()), body([]), body([])];
    case "twenty full pages of entries without an email":
      return [...Array.from({ length: 20 }, () => body(blankPage())), body([])];
    case "a full first page with usable entries":
      return [body(Array.from({ length: 500 }, (_, i) => ({ created: i, email: `bounced${i}@example.com` })))];
    case "a bounce list with a failing status":
      return [body({ errors: [] }, 401), body([])];
    case "a bounce list that is not an array":
      return [body({ errors: [] }), body([])];
    case "a bounce list that is not JSON":
      return [body("<html>"), body([])];
    case "a bounce list with a server error then empty blocks":
      return [body("", 500), body([])];
    default:
      return Array.from({ length: 10 }, () => body([]));
  }
}
const blankPage = () => Array.from({ length: 500 }, (_, i) => ({ created: i, email: i % 2 === 0 ? "" : null }));

function keysFor(c: Case): (string | undefined)[] {
  const used = new Set(c.http.map((request) => request.headers.Authorization!.replace("Bearer SG.example-", "")));
  if (c.name === "blank api keys") return ["", "  ", undefined, undefined, undefined];
  return SUBUSERS.map((subuser) => (used.has(subuser) ? `SG.example-${subuser}` : undefined));
}

describe("StaleTransientSuppressionSweepJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const recording = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const answers = answersFor(c);
      const requests: Http[] = [];
      const fetchSendGrid: SuppressionFetch = (url, init) => {
        requests.push({ method: "GET", url, headers: init.headers });
        return Promise.resolve(answers.shift() ?? new Response("{}"));
      };
      const handler = staleTransientSuppressionSweepJobWith({
        now: () => new Date(Math.round(golden.now * 1000)),
        apiKeys: () => keysFor(c),
        fetch: fetchSendGrid,
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      const sent = requests.map((request) => ({
        ...request,
        url: normalized(request.url),
        headers: { Authorization: request.headers.Authorization, Accept: request.headers.Accept },
      }));
      const expected = c.http.map((request) => ({
        method: request.method,
        url: normalized(request.url.replace(":443", "")),
        headers: request.headers,
      }));
      if (c.hands_back || NODE_HANDS_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sent).toEqual(expected.slice(0, sent.length));
        expect(sent.length).toBeGreaterThan(0);
      } else {
        expect(error).toBeNull();
        expect(sent).toEqual(expected);
      }
      expect(recording.snapshot()).toEqual({});
    });
  }
});

// WebMock sorts the query; compare it parsed.
function normalized(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  return parsed.toString();
}
