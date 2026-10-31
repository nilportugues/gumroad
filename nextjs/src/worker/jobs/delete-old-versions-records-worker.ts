// Port of app/sidekiq/delete_old_versions_records_worker.rb
import type { PrismaClient } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { replicaLagWatcher } from "../../server/infra/replica-lag-watcher.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const MAX_ALLOWED_ROWS = 100_000_000n;
const DELETION_BATCH_SIZE = 100;

type Deps = { db: () => Pick<PrismaClient, "$queryRaw" | "$executeRaw">; watchReplicaLag: () => Promise<void> };

export function deleteOldVersionsRecordsWorkerWith(deps: Deps): JobHandler {
  return async (args) => {
    checkArity(args, 0);
    // Counting rows is not free, so this relies on ids being consecutive instead.
    const [row] = await deps.db().$queryRaw<{ max_id: bigint | number | null }[]>`SELECT MAX(\`versions\`.\`id\`) AS max_id FROM \`versions\``;
    if (row?.max_id === null || row?.max_id === undefined) return;

    const minimumIdToKeep = BigInt(row.max_id) - MAX_ALLOWED_ROWS;
    for (;;) {
      await deps.watchReplicaLag();
      const deleted = await deps.db().$executeRaw`DELETE FROM \`versions\` WHERE (id <= ${minimumIdToKeep}) LIMIT ${DELETION_BATCH_SIZE}`;
      if (deleted === 0) break;
    }
  };
}

export const deleteOldVersionsRecordsWorker = deleteOldVersionsRecordsWorkerWith({ db: () => db, watchReplicaLag: () => replicaLagWatcher().watch() });
