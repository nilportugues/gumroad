// Replays partner-migration-import-job.golden.json (scripts/golden/partner-migration-import-job.rb): the job run by the real app as a
// Sidekiq job. Node sends the statements Rails sent up to the claim, ends a migration that is not claimed and has not completed, raises
// the RecordNotFound Rails raised, and hands back a claimed migration, a completed one (the notification push) and an id Rails casts.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import {
  partnerMigrationImportJobRetriesExhausted,
  partnerMigrationImportJobWith,
} from "./partner-migration-import-job.ts";

const golden = loadGolden(new URL("./__fixtures__/partner-migration-import-job.golden.json", import.meta.url));

// Rails casts a word to NULL and a float to an integer; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "PartnerMigrationImportJob",
  golden,
  partnerMigrationImportJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);

// The exhausted block is not recorded (it writes and ends in ErrorNotifier); it must hand back before any read or push.
describe("PartnerMigrationImportJob retries exhausted", () => {
  it("hands back whole without a read or a push", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      Promise.resolve().then(() =>
        partnerMigrationImportJobRetriesExhausted({ args: [1], jid: "j" } as never, new Error("boom"), { runtime }),
      ),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(recording.snapshot()).toEqual({});
  });
});
