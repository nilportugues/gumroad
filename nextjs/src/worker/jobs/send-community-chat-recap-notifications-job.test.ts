// Replays community-chat-recap-notifications.golden.json (scripts/golden/community-chat-recap-notifications.rb):
// the real job run as production Sidekiq runs it. Node must send the same statements, queue the same
// Sidekiq payloads and report the same errors.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { sendCommunityChatRecapNotificationsJobWith } from "./send-community-chat-recap-notifications-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  notified: { class: string; message: string }[];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/community-chat-recap-notifications.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: Case[];
};

// The Ruby error classes the job's rescue-all reported, as Node names them.
const RUBY_CLASS: Record<string, string> = { RecordNotFoundError: "ActiveRecord::RecordNotFound", NilResourceError: "NoMethodError" };
// A resource that is not a product is where Node hands the job back; Ruby preloaded and rescued.
const HANDED_BACK = "a community on something other than a product";

describe("SendCommunityChatRecapNotificationsJob", () => {
  for (const c of golden.cases.filter((candidate) => candidate.name !== HANDED_BACK)) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const notified: Error[] = [];
      const handler = sendCommunityChatRecapNotificationsJobWith({ notify: (error) => notified.push(error as Error) });
      await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);

      expect(sql.log).toEqual(sql.expected);
      expect(notified.map((error) => ({ class: RUBY_CLASS[error.constructor.name] ?? error.constructor.name, message: error.message }))).toEqual(c.notified);
      // job_id is a random UUID in production; the generator numbered them in push order.
      const withoutJobIds = (snapshot: RedisSnapshot) => JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  it("hands the job to Rails, with nothing queued, when a community's resource is not a product", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
    const c = golden.cases.find((candidate) => candidate.name === HANDED_BACK)!;
    sqlReplay(c.statements);
    const handler = sendCommunityChatRecapNotificationsJobWith({ notify: () => {} });
    await expect(asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now)).rejects.toBeInstanceOf(HandBackToRuby);
    expect(recording.snapshot()).toEqual({});
  });
});
