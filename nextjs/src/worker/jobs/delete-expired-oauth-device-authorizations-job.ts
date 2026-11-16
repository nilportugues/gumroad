// Port of app/sidekiq/delete_expired_oauth_device_authorizations_job.rb, including the
// OauthDeviceAuthorization.expired_for_cleanup scope. Golden: __fixtures__/delete-expired-oauth-device-authorizations-job.golden.json
// (scripts/golden/delete-expired-oauth-device-authorizations-job.rb).
import { Prisma } from "@prisma/client";

import { columnIn, execute, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const OAUTH_DEVICE_AUTHORIZATIONS = "oauth_device_authorizations";
const DELETION_BATCH_SIZE = 100;
const EXPIRABLE_STATUSES = ["pending", "approved", "denied", "consumed"];

// An approval made before expiry stays until the client's last poll, one interval after expires_at, has landed.
function expiredForCleanup(now: Date): Prisma.Sql {
  return Prisma.sql`${columnIn(OAUTH_DEVICE_AUTHORIZATIONS, "status", EXPIRABLE_STATUSES)} AND (expires_at <= ${now}) AND NOT ((status = 'approved' AND approved_at IS NOT NULL AND approved_at < expires_at AND DATE_ADD(expires_at, INTERVAL poll_interval_seconds SECOND) > ${now}))`;
}

export const deleteExpiredOauthDeviceAuthorizationsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  for (;;) {
    await deps.watchReplicaLag();
    const deleted = await execute(
      Prisma.sql`DELETE FROM ${table(OAUTH_DEVICE_AUTHORIZATIONS)} WHERE ${expiredForCleanup(deps.now())} LIMIT ${Prisma.raw(String(DELETION_BATCH_SIZE))}`,
    );
    if (deleted < DELETION_BATCH_SIZE) break;
  }
});
export const deleteExpiredOauthDeviceAuthorizationsJob = deleteExpiredOauthDeviceAuthorizationsJobWith();
