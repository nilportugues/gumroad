// Replays post-to-individual-ping-endpoint-worker.golden.json (scripts/golden/post-to-individual-ping-endpoint-worker.rb): the job run by
// the real app as a Sidekiq job, the POST stood in for by a marker exception. Node finishes the deliveries SsrfFilter refuses from the
// URL alone and hands every other case back whole, before any statement.
import { describe, expect, it } from "vitest";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { postToIndividualPingEndpointWorkerWith } from "./post-to-individual-ping-endpoint-worker.ts";

const golden = loadGolden(
  new URL("./__fixtures__/post-to-individual-ping-endpoint-worker.golden.json", import.meta.url),
);
const now = () => new Date(Math.round(Number(golden.now) * 1000));

// What Node finishes: the URL alone refuses it and every argument is one Node reproduces.
const FINISHED = /^(a scheme other than http and https|a private address|a nil user id)/u;
const HANDED_BACK_ANYWAY = new Set([
  "a scheme other than http and https and an endpoint past the column's length",
  "a scheme other than http and https and a ping with ids that are Strings",
  "a scheme other than http and https and a user id given as a String",
  "a scheme other than http and https and a ping with a resource name that is not a String",
]);
const finishes = (c: JobCase) => FINISHED.test(c.name) && !HANDED_BACK_ANYWAY.has(c.name) && !c.hands_back;

replayJobGolden(
  "PostToIndividualPingEndpointWorker",
  golden,
  postToIndividualPingEndpointWorkerWith({ now }),
  (c) => !finishes(c),
);

describe("PostToIndividualPingEndpointWorker coverage", () => {
  it("finishes the refusals the golden proves", () => {
    const finished = golden.cases.filter(finishes);
    expect(finished.length).toBeGreaterThan(40);
    expect(finished.some((c) => c.statements.some((s) => s.sql.startsWith("INSERT INTO `ping_deliveries`")))).toBe(
      true,
    );
  });
});
