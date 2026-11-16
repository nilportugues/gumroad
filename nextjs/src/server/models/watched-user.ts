// Port of app/models/watched_user.rb for SyncWatchedUsersJob: the validations an update runs. The alive-watch uniqueness check
// is create-only, so it is not ported, nor is the presence check of revenue_threshold_cents (the column is NOT NULL).
import type { WatchedUser } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesNumericalityOf } from "./runtime/validators.ts";

export const WATCHED_USERS = "watched_users";

export const WATCHED_USER_USER: BelongsTo = {
  name: "user",
  foreignKey: "user_id",
  targetTable: "users",
  targetModel: "User",
};

export const WatchedUsers = defineModel<WatchedUser>({
  rubyClass: "WatchedUser",
  prismaModel: "WatchedUser",
  delegate: (tx) => tx.watchedUser as never,
  validations: [
    belongsToRequired<WatchedUser>(WATCHED_USER_USER),
    validatesNumericalityOf<WatchedUser>(["revenue_threshold_cents"], { only_integer: true, greater_than: 0 }),
  ],
});
