// Port of the lookups of app/sidekiq/reindex_user_elasticsearch_data_worker.rb: a seller or an admin that no longer exists raises
// RecordNotFound, as in Rails (the seller is read first). With both, Rails reindexes everything of the seller in Elasticsearch
// (DevTools.reindex_all_for_user) and writes the admin note, which stays with Rails: the job is handed back right after the two reads.
// Golden: __fixtures__/reindex-user-elasticsearch-data-worker.golden.json (scripts/golden/reindex-user-elasticsearch-data-worker.rb); the
// reindex was replaced by a recorder there.
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const reindexUserElasticsearchDataWorkerWith = modelJob({ min: 2 }, async ([userId, adminId]) => {
  const user = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang<User>("User", user);
  // The admin id is checked once the seller was read, as Rails reads them in that order.
  const admin = await beforeSideEffects(() => recordIdFrom(adminId, "User.find"));
  await findByIdBang<User>("User", admin);

  throw new HandBackToRuby("DevTools.reindex_all_for_user and the admin note are not ported");
});

export const reindexUserElasticsearchDataWorker = reindexUserElasticsearchDataWorkerWith();
