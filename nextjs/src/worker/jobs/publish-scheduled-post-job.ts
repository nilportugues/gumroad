// Port of app/sidekiq/publish_scheduled_post_job.rb: publishes a post whose scheduled time came, if the rule it was scheduled
// under is still the current one.
// Golden: __fixtures__/publish-scheduled-post.golden.json (scripts/golden/publish-scheduled-post.rb).
//
// A post that emails its audience, or has files, or is reviewed by content moderation hands back to Rails from inside the
// lock, before the publish writes anything (installment-writes.ts lists what Node cannot prove). Rails then reruns the job
// from the start; the rolled back transaction left nothing behind.
import type { Installment } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { InstallmentFlags, InstallmentPost } from "../../server/models/installment-post.ts";
import { Installments, publishBang } from "../../server/models/installment-writes.ts";
import { nilReceiver } from "../../server/models/offer-code.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { NotPortedError } from "../../server/models/user.ts";
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

      const rule = await new InstallmentPost(record.attributes as Installment).installmentRule();
      if (rule === null) throw nilReceiver("version");
      // the version may have changed (e.g. the post was rescheduled), and the rule deleted
      if (args[1] !== rule.version) return;
      if (rule.deleted_at !== null) return;

      await beforeSideEffects(async () => {
        // `can_be_blasted?`: a post that emails its audience also gets a PostEmailBlast, which Node does not create
        if (InstallmentFlags.isSet(record.get("flags") as number, "send_emails")) throw new NotPortedError("a post that emails its audience (PostEmailBlast)", "publish_scheduled_post_job.rb");
        await publishBang(record, { now: deps.now });
      });
    });
  })(overrides);

export const publishScheduledPostJob = publishScheduledPostJobWith();
