// Replays send-bundles-marketing-email-job.golden.json (scripts/golden/send-bundles-marketing-email-job.rb): the job run by the real app
// as a Sidekiq job, with the first `Link.search` stood in for by a marker exception (nothing leaves the machine). Node sends the scan
// Rails sent and finishes a year with no seller paid out; a scan that finds a seller checks replica lag once and hands the job back
// whole, before any write.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { sendBundlesMarketingEmailJobWith } from "./send-bundles-marketing-email-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/send-bundles-marketing-email-job.golden.json", import.meta.url),
) as ReturnType<typeof loadGolden> & { cases: (JobCase & { replica_lag_watches: number })[] };
const now = () => new Date(Math.round(Number(golden.now) * 1000));

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    jobs: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

describe("SendBundlesMarketingEmailJob", () => {
  for (const c of golden.cases) {
    it(c.hands_back ? `hands back ${c.name} before any write` : c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, jobs } = runtime();
      let watches = 0;
      const handler = sendBundlesMarketingEmailJobWith({
        now,
        watchReplicaLag: () => {
          watches += 1;
          return Promise.resolve();
        },
      });
      const error = await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now).then(
        () => null,
        (e: unknown) => e as Error,
      );

      if (c.hands_back) expect(error?.name).toBe("HandBackToRuby");
      else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_lag_watches);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const { jobs } = runtime();
    const handler = sendBundlesMarketingEmailJobWith({ now });
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
