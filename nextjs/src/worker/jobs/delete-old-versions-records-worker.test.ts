import { describe, expect, it } from "vitest";

import { contextFor, goldenRuntime, recordingSidekiqRedis } from "./__fixtures__/golden.ts";
import { deleteOldVersionsRecordsWorkerWith } from "./delete-old-versions-records-worker.ts";

// Records statements as ActiveRecord would log them, with each bind written in place of its `?`.
function fakeDb(maxId: bigint | null, deletions: number[]) {
  const log: string[] = [];
  const render = (strings: TemplateStringsArray, values: unknown[]) => strings.reduce((sql, part, i) => sql + String(values[i - 1]) + part);
  const db = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(render(strings, values));
      return [{ max_id: maxId }];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(render(strings, values));
      return deletions.shift() ?? 0;
    },
  };
  return { db: () => db as never, log };
}

const context = () => contextFor(goldenRuntime(recordingSidekiqRedis().redis));

describe("DeleteOldVersionsRecordsWorker", () => {
  it("deletes in batches of 100 below the newest 100M ids, checking replica lag before each", async () => {
    const { db, log } = fakeDb(100_000_250n, [100, 100, 50, 0]);
    const events: string[] = [];
    const handler = deleteOldVersionsRecordsWorkerWith({ db, watchReplicaLag: async () => void events.push("watch") });
    const originalPush = log.push.bind(log);
    log.push = (...lines: string[]) => (events.push(...lines), originalPush(...lines));

    await handler([], context());

    const deleteSql = "DELETE FROM `versions` WHERE (id <= 250) LIMIT 100";
    expect(events).toEqual([
      "SELECT MAX(`versions`.`id`) AS max_id FROM `versions`",
      ...Array.from({ length: 4 }, () => ["watch", deleteSql]).flat(),
    ]);
  });

  it("issues the delete even when nothing is old enough, as Ruby does", async () => {
    const { db, log } = fakeDb(5n, []);
    await deleteOldVersionsRecordsWorkerWith({ db, watchReplicaLag: async () => {} })([], context());
    expect(log).toEqual(["SELECT MAX(`versions`.`id`) AS max_id FROM `versions`", "DELETE FROM `versions` WHERE (id <= -99999995) LIMIT 100"]);
  });

  it("stops when the table is empty", async () => {
    const { db, log } = fakeDb(null, []);
    await deleteOldVersionsRecordsWorkerWith({ db, watchReplicaLag: async () => {} })([], context());
    expect(log).toEqual(["SELECT MAX(`versions`.`id`) AS max_id FROM `versions`"]);
  });
});
