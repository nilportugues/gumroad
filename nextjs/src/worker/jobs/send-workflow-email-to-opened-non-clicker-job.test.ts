// Replays send-workflow-email-to-opened-non-clicker-job.golden.json (scripts/golden/send-workflow-email-to-opened-non-clicker-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the statements Rails sent for every check that ends the job, and hands the
// send back (before any write) in the cases Rails reached `send_installment_from_workflow_for_opened_no_click`.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  asSidekiqJob,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { sendWorkflowEmailToOpenedNonClickerJobWith } from "./send-workflow-email-to-opened-non-clicker-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/send-workflow-email-to-opened-non-clicker-job.golden.json", import.meta.url),
);

replayJobGolden("SendWorkflowEmailToOpenedNonClickerJob", golden, sendWorkflowEmailToOpenedNonClickerJobWith());

describe("SendWorkflowEmailToOpenedNonClickerJob arguments Node does not reproduce", () => {
  async function run(args: Parameters<ReturnType<typeof sendWorkflowEmailToOpenedNonClickerJobWith>>[0]) {
    const sql = sqlReplay([]);
    const recording = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = sendWorkflowEmailToOpenedNonClickerJobWith();
    const error = await asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now).then(
      () => null,
      (e: unknown) => e as Error,
    );
    return { error, log: sql.log };
  }

  it("hands an installment id that is not an Integer back before any statement", async () => {
    const { error, log } = await run(["abc", 3, 5, "digest"]);
    expect(error?.name).toBe("HandBackToRuby");
    expect(log).toEqual([]);
  });

  it("rejects fewer than four arguments, as perform takes four", async () => {
    const { error, log } = await run([1, 3, 5]);
    expect(error).not.toBeNull();
    expect(log).toEqual([]);
  });

  it("hands a Float rule version back whole once the rule is found", async () => {
    const c = golden.cases.find((x) => x.name === "a job version given as a Float equal to the rule's")!;
    const sql = sqlReplay(c.statements);
    const recording = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const error = await asSidekiqJob(
      () => sendWorkflowEmailToOpenedNonClickerJobWith()([1, new RubyFloat(3), 5, "digest"], contextFor(jobs)),
      golden.now,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
  });
});
