// Port of app/sidekiq/generate_subscribe_preview_job.rb up to the image generation. `User.find` runs in Node (a missing user raises
// RecordNotFound); a user gets a generated PNG and an Active Storage attach, which hand back before any of it. The exhausted block is
// `perform(*args, require_avatar: false)`: the same read, then a hand back, after which Rails runs one more attempt (with the avatar
// requirement) and, if that fails, the Ruby block itself. Golden: __fixtures__/generate-subscribe-preview-job.golden.json
// (scripts/golden/generate-subscribe-preview-job.rb).
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

export const generateSubscribePreviewJobWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang<User>("User", id);

  throw new HandBackToRuby("the subscribe preview image is generated");
});
export const generateSubscribePreviewJob = generateSubscribePreviewJobWith();

export const generateSubscribePreviewJobRetriesExhaustedWith =
  (handler = generateSubscribePreviewJob): RetriesExhausted =>
  async (msg, _error, { runtime }) => {
    await handler(msg.args as JsonValue[], { jid: String(msg.jid), item: msg, attemptsMade: 0, runtime });
  };
export const generateSubscribePreviewJobRetriesExhausted = generateSubscribePreviewJobRetriesExhaustedWith();
