// Replays mcp-delete-expired-event-subscriptions-job.golden.json (scripts/golden/mcp-delete-expired-event-subscriptions-job.rb):
// Mcp::DeleteExpiredEventSubscriptionsJob run by the real app as a Sidekiq job. Node sends the same scans, seller locks and deletes,
// checks replica lag before each batch of sellers, and stops on the first empty scan.
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
import { mcpDeleteExpiredEventSubscriptionsJobWith } from "./mcp-delete-expired-event-subscriptions-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/mcp-delete-expired-event-subscriptions-job.golden.json", import.meta.url),
) as ReturnType<typeof loadGolden> & { cases: (JobCase & { replica_lag_watches: number })[] };
const now = () => new Date(Math.round(golden.now * 1000));

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

describe("Mcp::DeleteExpiredEventSubscriptionsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let watches = 0;
      const handler = mcpDeleteExpiredEventSubscriptionsJobWith({
        now,
        watchReplicaLag: () => {
          watches += 1;
          return Promise.resolve();
        },
      });
      await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now);

      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_lag_watches);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    const handler = mcpDeleteExpiredEventSubscriptionsJobWith({ now });
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
