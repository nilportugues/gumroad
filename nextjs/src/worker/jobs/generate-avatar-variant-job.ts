// Port of app/sidekiq/generate_avatar_variant_job.rb up to the avatar: a user that is gone, or has no avatar attached, ends the job
// after the user read and the attachment read. An attached avatar is where `stored_avatar_variant` processes the image and writes the
// variant to storage, which goes back to Rails whole before any write.
// Golden: __fixtures__/generate-avatar-variant-job.golden.json (scripts/golden/generate-avatar-variant-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const ATTACHMENTS = "active_storage_attachments";
const attachments = (name: string) => column(ATTACHMENTS, name);

export const generateAvatarVariantJobWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find_by"));
  const user = await findById("User", id);
  if (user === null) return;

  // `user.avatar.attached?`: the has_one attachment of the record
  const [attachment] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table(ATTACHMENTS)} WHERE ${attachments("record_id")} = ${id} AND ${attachments("record_type")} = 'User' AND ${attachments("name")} = 'avatar' LIMIT 1`,
  );
  if (attachment === undefined) return;

  throw new HandBackToRuby("an attached avatar is resized and its variant stored");
});
export const generateAvatarVariantJob = generateAvatarVariantJobWith();
