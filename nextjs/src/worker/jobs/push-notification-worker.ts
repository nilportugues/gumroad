// Port of app/sidekiq/push_notification_worker.rb up to the first push. `User.find` and the receiver's devices of the app type run in
// Node: a receiver with no iOS or Android device finishes the job (a device of another type is skipped). The first iOS or Android
// device means APNs or FCM, which hand back to Rails before the call, as does a push to the receiver's team admins (its own member
// query) and an id or app type Rails casts. Golden: __fixtures__/push-notification-worker.golden.json
// (scripts/golden/push-notification-worker.rb).
import { Prisma, type Device, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PUSH_DEVICE_TYPES = ["ios", "android"];
const TO_TEAM_ADMINS_INDEX = 6;

export const pushNotificationWorkerWith = modelJob({ min: 3, max: 7 }, async (args) => {
  const [receiverId, appType] = args;
  const id = await beforeSideEffects(() => recordIdFrom(receiverId, "User.find"));
  if (typeof appType !== "string") throw new HandBackToRuby("the app type is not a string");
  // `false` and nil (and the default) take the receiver's own devices; anything else is the team admins branch
  const toTeamAdmins = args[TO_TEAM_ADMINS_INDEX];
  if (toTeamAdmins !== undefined && toTeamAdmins !== null && toTeamAdmins !== false) throw new HandBackToRuby("a push to the receiver's team admins");

  await findByIdBang<User>("User", id);
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`devices`.*")} FROM ${table("devices")} WHERE ${column("devices", "user_id")} = ${id} AND ${column("devices", "app_type")} = ${appType}`,
  );
  for (const row of rows) {
    const device = castRow<Device>("Device", row);
    if (PUSH_DEVICE_TYPES.includes(device.device_type)) throw new HandBackToRuby("a push notification is sent to a device");
  }
});
export const pushNotificationWorker = pushNotificationWorkerWith();
