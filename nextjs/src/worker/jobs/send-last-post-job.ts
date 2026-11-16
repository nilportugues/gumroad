// Port of app/sidekiq/send_last_post_job.rb: a new buyer who can be contacted gets the newest post that applies to them (a
// product, variant or seller post that sends email and whose filters they pass), once.
// Golden: __fixtures__/installment-sends.golden.json (scripts/golden/installment-sends.rb).
//
// A post with files hands back to Rails after its SentPostEmail claim (UrlRedirect is not ported), with the claim deleted
// again, as SendWorkflowInstallmentWorker does; so does anything the post email template cannot render.
import { Prisma, type Subscription } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { emailablePostsForPurchase } from "../../server/models/installment-emailable.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { defaultSendDeps, ensureUniqueness, refuseFiles, sendPostEmailDirect, type SendDeps } from "../../server/models/installment-send.ts";
import { defaultPostEmailDeps, type PostEmailDeps, type Recipient } from "../../server/models/post-email-api.ts";
import { findPurchaseBang, purchaseIdFrom } from "../../server/models/purchase.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findById } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { SubscriptionRecord } from "../../server/models/subscription.ts";
import { purchasePassesFilters } from "../../server/models/with-filtering.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

export const sendLastPostJobWith = (overrides: Partial<JobDeps> = {}, send: Partial<PostEmailDeps> & { subscriptionDeps?: SendDeps["subscriptionDeps"] } = {}) =>
  modelJob({ min: 1 }, async (args, deps) => {
    const sendDeps: SendDeps = { ...defaultSendDeps({ ...defaultPostEmailDeps(), now: deps.now, ...send }), ...(send.subscriptionDeps ? { subscriptionDeps: send.subscriptionDeps } : {}) };

    const found = await beforeSideEffects(async () => {
      const row = await findPurchaseBang(purchaseIdFrom(args[0]));
      // The buyer unchecked email updates at checkout, or unsubscribed before this ran.
      if (row.can_contact !== true) return null;
      const subscriptionRow = row.subscription_id === null ? null : await findById<Subscription>("Subscription", row.subscription_id);
      const subscription = subscriptionRow === null ? null : new SubscriptionRecord(subscriptionRow, sendDeps.subscriptionDeps);
      const purchase = new PurchaseRecord(row, subscription);

      const variantIds = await selectRows<{ id: number }>(
        Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${row.id}`,
      );
      const posts = (await emailablePostsForPurchase(row, variantIds.map((variant) => variant.id))).map((installment) => new InstallmentPost(installment));
      for (const post of posts) {
        if (await purchasePassesFilters(post, purchase)) return { post, row, subscription };
      }
      return null;
    });
    if (found === null) return;

    const { post, row, subscription } = found;
    await ensureUniqueness(post, row.email, { table: "purchases", id: row.id }, sendDeps, async () => {
      const recipient: Recipient = { email: row.email!, purchase: row, ...(subscription === null ? {} : { subscription: { id: subscription.id } }) };
      await refuseFiles(post, recipient);
      await sendPostEmailDirect(post, recipient, sendDeps);
    });
  })(overrides);

export const sendLastPostJob = sendLastPostJobWith();
