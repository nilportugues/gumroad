// Creation of a PostEmailBlast (app/models/post_email_blast.rb): the row that asks SendPostBlastEmailsJob to email a post's
// audience. Golden: worker/jobs/__fixtures__/publish-scheduled-post.golden.json. The blast bookkeeping the send itself does
// (`acknowledge_email_delivery`, `expire`, ...) stays in Ruby with SendPostBlastEmailsJob.
import { Prisma, type Installment, type PostEmailBlast } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { belongsToRequired, setAssociation } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesInclusionOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import type { InstallmentPost } from "./installment-post.ts";

// PostEmailBlast::RECIPIENT_FILTER_UNOPENED
export const RECIPIENT_FILTER_UNOPENED = "unopened";

const POST = "postEmailBlastPost";

export const PostEmailBlasts = defineModel<PostEmailBlast>({
  rubyClass: "PostEmailBlast",
  prismaModel: "PostEmailBlast",
  delegate: (tx) => tx.postEmailBlast as never,
  beforeValidation: [
    {
      // before_validation -> { self.seller = post.seller }, on: :create
      name: "seller = post.seller",
      on: "create",
      async run(record) {
        const seller = await (record.ivars[POST] as InstallmentPost).seller();
        record.set("seller_id", (seller?.id ?? null) as PostEmailBlast["seller_id"]);
        setAssociation(record, "seller", record.get("seller_id"), seller);
      },
    },
  ],
  validations: [
    belongsToRequired<PostEmailBlast>({ name: "post", foreignKey: "post_id", targetTable: "installments", targetModel: "Installment" }),
    belongsToRequired<PostEmailBlast>({ name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" }),
    validatesInclusionOf<PostEmailBlast>(["recipient_filter"], { in: [RECIPIENT_FILTER_UNOPENED], allow_nil: true }),
  ],
});

// `post.has_been_blasted?`: `blasts.exists?` on a post whose blasts are not loaded.
export async function hasBeenBlasted(postId: number | bigint): Promise<boolean> {
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table("post_email_blasts")} WHERE ${column("post_email_blasts", "post_id")} = ${postId} LIMIT 1`);
  return rows.length > 0;
}

// `PostEmailBlast.create!(post:, requested_at:, recipient_filter:)`
export async function createBlast(post: InstallmentPost, attributes: { requested_at: Date | null; recipient_filter?: string | null }, now?: () => Date): Promise<ModelRecord<PostEmailBlast>> {
  const record = PostEmailBlasts.build({ post_id: BigInt(post.id), ...attributes });
  record.ivars[POST] = post;
  setAssociation(record, "post", record.get("post_id"), post.row as Installment);
  await PostEmailBlasts.saveBang(record, { now });
  return record;
}

// `PostEmailBlast.create!(post:, requested_at:)` followed by `SendPostBlastEmailsJob.perform_async(blast.id)`.
export async function createBlastAndEnqueue(post: InstallmentPost, requestedAt: Date | null, now?: () => Date): Promise<ModelRecord<PostEmailBlast>> {
  const record = await createBlast(post, { requested_at: requestedAt }, now);
  await performAsync("SendPostBlastEmailsJob", [Number(record.get("id"))]);
  return record;
}
