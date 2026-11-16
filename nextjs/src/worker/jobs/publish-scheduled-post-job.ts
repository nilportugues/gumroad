// Port of app/sidekiq/publish_scheduled_post_job.rb: publishes a post whose scheduled time came, if the rule it was scheduled
// under is still the current one.
// Golden: __fixtures__/publish-scheduled-post.golden.json (scripts/golden/publish-scheduled-post.rb).
//
// A post with files, or one the sanitizer or content moderation would have to judge hands back to Rails
// from inside the lock, before the publish writes anything (installment-writes.ts lists what Node cannot prove). Rails then
// reruns the job from the start; the rolled back transaction left nothing behind. A post that emails its audience gets its
// PostEmailBlast and the SendPostBlastEmailsJob push here, which is Ruby's `can_be_blasted?` branch.
import type { Installment } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { InstallmentFlags } from "../../server/models/installment-post.ts";
import { Installments, post as postOf, publishBang } from "../../server/models/installment-writes.ts";
import { nilReceiver } from "../../server/models/offer-code.ts";
import { createBlastAndEnqueue, hasBeenBlasted } from "../../server/models/post-email-blast.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

export const publishScheduledPostJobWith = (overrides: Partial<JobDeps> = {}) =>
  modelJob({ min: 2 }, async (args, deps) => {
    const id = await beforeSideEffects(() => recordIdFrom(args[0], "Installment.find"));
    const record = Installments.load(await findByIdBang<Installment>("Installment", id));

    await transaction(async () => {
      await Installments.lockBang(record);
      // post may have been deleted, or published already
      if (record.get("deleted_at") !== null) return;
      if (record.get("published_at") !== null) return;

      const rule = await postOf(record).installmentRule();
      if (rule === null) throw nilReceiver("version");
      // the version may have changed (e.g. the post was rescheduled), and the rule deleted
      if (args[1] !== rule.version) return;
      if (rule.deleted_at !== null) return;

      await beforeSideEffects(() => publishBang(record, { now: deps.now }));

      // `can_be_blasted?`
      if (InstallmentFlags.isSet(record.get("flags") as number, "send_emails") && !(await hasBeenBlasted(record.get("id")))) {
        await createBlastAndEnqueue(postOf(record), rule.to_be_published_at, deps.now);
      }
    });
  })(overrides);

export const publishScheduledPostJob = publishScheduledPostJobWith();
