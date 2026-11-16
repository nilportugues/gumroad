// Port of app/sidekiq/send_post_blast_emails_slice_job.rb up to its first guard: `PostEmailBlast.find`, the post, and the one `return
// unless` over them (the post is alive, published, sends emails, and the blast is not completed), which retires every stale slice of a
// finished or withdrawn blast. A slice that passes it goes on to the partition marker in Redis, the chunk claim and the sends, and is
// handed back right there with nothing written. A blast whose post is gone is a NoMethodError in Rails and is handed back after the
// same two statements; an id Rails casts (nil, a float, a word) hands back before any statement.
// Golden: __fixtures__/send-post-blast-emails-slice-job.golden.json (scripts/golden/send-post-blast-emails-slice-job.rb).
import type { Installment, PostEmailBlast } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { InstallmentFlags } from "../../server/models/installment-post.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const sendPostBlastEmailsSliceJobWith = modelJob({ min: 5 }, async ([blastId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(blastId, "PostEmailBlast.find"));
  const blast = await findByIdBang<PostEmailBlast>("PostEmailBlast", id);
  const post = await findOneBy<Installment>("Installment", "id", blast.post_id);
  if (post === null) throw new HandBackToRuby("a blast whose post is gone raises in Rails");

  const live =
    post.deleted_at === null &&
    post.published_at !== null &&
    InstallmentFlags.isSet(post.flags, "send_emails") &&
    blast.completed_at === null;
  if (!live) return;

  throw new HandBackToRuby("the partition marker, the chunk claim and the sends of a blast slice are not ported");
});

export const sendPostBlastEmailsSliceJob = sendPostBlastEmailsSliceJobWith();
