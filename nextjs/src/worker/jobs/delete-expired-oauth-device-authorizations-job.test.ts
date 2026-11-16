// Replays delete-expired-oauth-device-authorizations-job.golden.json (scripts/golden/delete-expired-oauth-device-authorizations-job.rb):
// DeleteExpiredOauthDeviceAuthorizationsJob run by the real app as a Sidekiq job. Node sends the same DELETE batches, checks replica
// lag before each, and stops after the same short batch.
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
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { deleteExpiredOauthDeviceAuthorizationsJobWith } from "./delete-expired-oauth-device-authorizations-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  replica_lag_watches: number;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/delete-expired-oauth-device-authorizations-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };
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

describe("DeleteExpiredOauthDeviceAuthorizationsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let watches = 0;
      const handler = deleteExpiredOauthDeviceAuthorizationsJobWith({
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
    const handler = deleteExpiredOauthDeviceAuthorizationsJobWith({ now });
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
