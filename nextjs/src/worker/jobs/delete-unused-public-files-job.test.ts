// Replays delete-unused-public-files-job.golden.json (scripts/golden/delete-unused-public-files-job.rb): DeleteUnusedPublicFilesJob
// run by the real app as a Sidekiq job. Node sends the statements Rails sent (the batch query, the Active Storage preload, each file's
// validations and soft delete, the shared-blob check, the attachment delete and touch) and pushes the same ActiveStorage::PurgeJob
// items. A case named "hands ..." is one Node gives back: it must stop after the preload, before any write.
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
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { deleteUnusedPublicFilesJobWith } from "./delete-unused-public-files-job.ts";

type Case = {
  name: string;
  args: never[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/delete-unused-public-files-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

function run(c: Case, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let uuids = 0;
  let lagChecks = 0;
  const handler = deleteUnusedPublicFilesJobWith({
    now: () => new Date(Math.round(golden.now * 1000)),
    uuid: () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, "0")}`,
    watchReplicaLag: () => Promise.resolve(void (lagChecks += 1)),
  });
  const result = asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now).then(
    () => null,
    (error: unknown) => error as Error,
  );
  return { sql, recording, result, lagChecks: () => lagChecks };
}

describe("DeleteUnusedPublicFilesJob", () => {
  for (const c of golden.cases.filter((c) => !c.name.startsWith("hands "))) {
    it(c.name, async () => {
      const { sql, recording, result, lagChecks } = run(c, c.statements);
      const error = await result;

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
      // One check per batch that has files (the goldens never reach a second batch), none when the batch query finds nothing.
      expect(lagChecks()).toBe((c.statements[0]?.result?.rows?.length ?? 0) > 0 && c.statements.length > 1 ? 1 : 0);
    });
  }

  for (const c of golden.cases.filter((c) => c.name.startsWith("hands "))) {
    it(c.name, async () => {
      const begin = c.statements.findIndex((s) => s.sql === "BEGIN");
      const beforeFirstWrite = begin === -1 ? c.statements : c.statements.slice(0, begin);
      const { sql, recording, result } = run(c, beforeFirstWrite);
      const error = await result;

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a batch back when a blob has a preview image", async () => {
    const c = golden.cases.find((c) => c.name === "a file with an attached blob")!;
    const statements = c.statements.slice(0, 5).map((s, i) =>
      i === 4
        ? {
            ...s,
            result: {
              ...s.result,
              rows: [[1, "preview_image", "ActiveStorage::Blob", 1, 9, { $time: "2026-01-01T00:00:00.000000Z" }]],
            },
          }
        : s,
    );
    const { sql, recording, result } = run(c, statements);

    expect((await result)?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });
});
