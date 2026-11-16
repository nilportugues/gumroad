// Port of app/sidekiq/send_post_blast_emails_job.rb up to the retired-newsletter check. The blast and its post are read in Node and the five
// guards that open the job (post deleted, unpublished, sending no emails, blast completed or expired) end it. A blast that passes them stamps
// `started_at` and loads and sends to its audience, so it goes back to Rails whole before that write. An id Rails casts goes back before any
// read, and so does a blast whose post is missing (Rails raises NoMethodError on it).
// Golden: __fixtures__/send-post-blast-emails-job.golden.json (scripts/golden/send-post-blast-emails-job.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";

import { modelJob } from "./support/job-deps.ts";

// has_flags 9 => :send_emails
const SEND_EMAILS = 1n << 8n;

type Blast = { post_id: bigint; completed_at: Date | null; expired_at: Date | null };
type Post = { deleted_at: Date | null; published_at: Date | null; flags: bigint };

export const sendPostBlastEmailsJobWith = modelJob({ min: 1, max: 1 }, async ([blastId]) => {
  if (blastId === null) throw new RecordNotFound("Couldn't find PostEmailBlast without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(blastId, "PostEmailBlast.find"));
  const blast = await findById<Blast & Record<string, unknown>>("PostEmailBlast", id);
  if (blast === null) throw new RecordNotFound(`Couldn't find PostEmailBlast with 'id'=${String(id)}`);

  const post = await findOneBy<Post & Record<string, unknown>>("Installment", "id", blast.post_id);
  if (post === null) throw new HandBackToRuby("a blast without a post raises NoMethodError in Rails");

  // `@post.alive? && @post.published? && @post.send_emails? && @blast.completed_at.nil? && @blast.expired_at.nil?`
  const sendable =
    post.deleted_at === null &&
    post.published_at !== null &&
    (BigInt(post.flags) & SEND_EMAILS) !== 0n &&
    blast.completed_at === null &&
    blast.expired_at === null;
  if (!sendable) return;

  throw new HandBackToRuby("the blast is stamped as started and its audience is loaded and sent to");
});
export const sendPostBlastEmailsJob = sendPostBlastEmailsJobWith();
