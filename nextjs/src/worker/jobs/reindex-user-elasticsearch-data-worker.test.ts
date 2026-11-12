// Replays reindex-user-elasticsearch-data-worker.golden.json (scripts/golden/reindex-user-elasticsearch-data-worker.rb): the job run by the
// real app as a Sidekiq job with the Elasticsearch reindex replaced by a recorder. A seller or admin that does not exist fails with the same
// statements and RecordNotFound; both existing is handed back right after the two reads. An id Rails casts (a float, a word) or reads as no
// id (nil) hands back, the admin's after the seller was read.
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { reindexUserElasticsearchDataWorkerWith } from "./reindex-user-elasticsearch-data-worker.ts";

const CAST_IDS = new Set(["a seller id of nil", "a seller id given as a float"]);
// The admin's id is read after the seller's statement.
const CAST_ADMIN = new Set(["an admin id of nil"]);

describeGuardedJob({
  title: "ReindexUserElasticsearchDataWorker",
  file: "reindex-user-elasticsearch-data-worker.golden.json",
  make: (deps) => reindexUserElasticsearchDataWorkerWith(deps),
  reached: (c) => (c.processed as number[]).length > 0 || CAST_ADMIN.has(c.name),
  castBefore: (c) => CAST_IDS.has(c.name),
});
