// Port of app/sidekiq/generate_username_job.rb up to the OpenAI call: a missing user raises RecordNotFound, a user who already has a
// username and one with neither an email nor a name (`UsernameGeneratorService#user_data` is nil) are left alone. Anyone else needs a
// completion from OpenAI, the uniqueness lookups and a locked update, so the job is handed back right after the user is read.
// Golden: __fixtures__/generate-username-job.golden.json (scripts/golden/generate-username-job.rb), recorded with OpenAI answered by WebMock.
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";

import { modelJob } from "./support/job-deps.ts";

export const generateUsernameJobWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  const user = await findByIdBang<User>("User", id);

  // `user.read_attribute(:username).present?`
  if (!isBlank(user.username)) return;
  // `user_data.nil?`: no email and no name
  if (isBlank(user.email) && isBlank(user.name)) return;

  throw new HandBackToRuby("the OpenAI username completion is not ported");
});

export const generateUsernameJob = generateUsernameJobWith();
