// Replays detect-failing-paypal-rails-job.golden.json (scripts/golden/detect-failing-paypal-rails-job.rb): DetectFailingPaypalRailsJob
// run by the real app as a Sidekiq job. Node sends the statements Rails sent (the account batches, the failed and completed counts,
// the user lock, the dedup check, the note and its version), reports the same per-account failures and carries on after them.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { Comments, COMMENT_TYPES } from "../../server/models/comment.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { detectFailingPaypalRailsJobWith } from "./detect-failing-paypal-rails-job.ts";

type Notified = {
  class: string;
  message: string;
  options: { context: { merchant_account_id: number; user_id: number } };
};
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  notified: Notified[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/detect-failing-paypal-rails-job.golden.json", import.meta.url), "utf8"),
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

describe("DetectFailingPaypalRailsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      // The recorder made `Comment#save!` raise for these users; the job rescues it per account and reports it.
      const failing = new Map(c.notified.map((n) => [n.options.context.user_id, n.message]));
      const reported: Notified[] = [];
      const handler = detectFailingPaypalRailsJobWith(
        { now },
        {
          notify: (error, context) =>
            reported.push({
              class: (error as Error).constructor.name,
              message: (error as Error).message,
              options: context as Notified["options"],
            }),
          createNote: (input, at) => {
            const message = failing.get(Number(input.userId));
            if (message !== undefined) return Promise.reject(new Error(message));
            return Comments.createBang(
              {
                commentable_id: input.userId,
                commentable_type: "User",
                author_name: "failing-paypal-rail",
                comment_type: COMMENT_TYPES.NOTE,
                content: input.content,
              },
              { now: at },
            );
          },
        },
      );
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(reported.map((r) => [r.message, r.options])).toEqual(c.notified.map((n) => [n.message, n.options]));
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }
});
