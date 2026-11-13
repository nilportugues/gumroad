// PostsController#send_for_purchase (app/controllers/posts_controller.rb): the seller re-sending a post to one customer from the
// customers page.
//
// The send clears the customer's earlier email records, rate-limits through Rails.cache (memcached) and mails through
// PostEmailApi. A post with files needs a UrlRedirect for the customer, which Node does not create: that request goes to
// Rails whole, before any write.
import { Prisma, type Installment, type Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { PostEmailNotPortedError } from "../mail/post-email-template.ts";
import { InstallmentFlags, InstallmentPost } from "../models/installment-post.ts";
import { defaultPostEmailDeps, processPostEmail } from "../models/post-email-api.ts";
import { column, execute, inList, selectRows, table } from "../models/sql.ts";
import { eligibleToSendEmails } from "../models/user-email-eligibility.ts";
import { isSuspended, Users } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { authorize } from "../policies/authorize.ts";
import { installmentPolicy } from "../policies/installment.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { json, noContent, UNAUTHORIZED, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

type PostRow = Installment;
type UserRow = Parameters<typeof Users.load>[0];

const isTrue = (value: unknown) => value === true || value === 1 || value === 1n;
const RESEND_LIMIT_SECONDS = 8 * 60 * 60;
const EMAIL_INFO_TYPE = "CreatorContactingCustomersEmailInfo";

// `CreatorContactingCustomersEmailInfo.where(purchase:, installment:)`, as ids; destroy_all also destroys each one's charge link.
async function earlierEmailInfoIds(purchaseId: bigint | number, postId: number): Promise<unknown[]> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("email_infos", "id")} FROM ${table("email_infos")} WHERE ${column("email_infos", "type")} = ${EMAIL_INFO_TYPE} AND ${column("email_infos", "purchase_id")} = ${purchaseId} AND ${column("email_infos", "installment_id")} = ${postId}`,
  );
  return rows.map((row) => row.id);
}

async function destroyEmailInfos(ids: unknown[]): Promise<void> {
  if (ids.length === 0) return;
  await execute(
    Prisma.sql`DELETE FROM ${table("email_info_charges")} WHERE ${column("email_info_charges", "email_info_id")} IN ${inList(ids)}`,
  );
  await execute(Prisma.sql`DELETE FROM ${table("email_infos")} WHERE ${column("email_infos", "id")} IN ${inList(ids)}`);
}

async function sendForPurchase(input: MutationInput): Promise<ActionResult> {
  const { request, context, routeParams } = input;
  const seller = context.currentSeller;
  if (railsLoggedInUser(context) === null || seller === null) throw new HandBackToRails("a signed-out request");
  if (requestFormat(request) !== "json") throw new HandBackToRails("a request whose format is not JSON");

  // fetch_post: a post of another seller, or of a suspended one, is a 404.
  const postId = decrypt(routeParams.id!);
  const [post] =
    postId === null
      ? []
      : await selectRows<PostRow>(
          Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} = ${postId} LIMIT 1`,
        );
  if (post === undefined || post.seller_id === null || BigInt(post.seller_id) !== BigInt(seller.id))
    throw new RoutingError("Not Found");
  const [owner] = await selectRows<UserRow>(
    Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${post.seller_id} LIMIT 1`,
  );
  if (owner === undefined) throw new HandBackToRails("a post whose seller row is missing");
  if (isSuspended(Users.load(owner))) throw new RoutingError("Not Found");

  // ensure_seller_is_eligible_to_send_emails
  if (!(await eligibleToSendEmails(seller)))
    return { ...json({ message: "You are not eligible to resend this email." }, UNAUTHORIZED), rescued: true };

  const sellerContext = await loadSellerContext(context);
  try {
    authorize(installmentPolicy.sendForPurchase, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    // PunditAuthorization#default_user_not_authorized
    return { ...json({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
  }

  // current_seller.sales.find_by_external_id!
  const purchaseId = decrypt(routeParams.purchase_id!);
  const [purchase] =
    purchaseId === null
      ? []
      : await selectRows<Purchase>(
          Prisma.sql`SELECT * FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "id")} = ${purchaseId} LIMIT 1`,
        );
  if (purchase === undefined) throw new RoutingError("Not Found");

  // The 404 for a single-recipient email sent to another purchase reads the post's JSON data, which is not ported.
  if (InstallmentFlags.isSet(post.flags, "single_recipient_email"))
    throw new HandBackToRails("a single-recipient email");
  if (!isTrue(purchase.can_contact))
    return json({ message: "This customer has unsubscribed from your emails." }, UNPROCESSABLE_ENTITY);

  const sent = new InstallmentPost(post);
  if (await sent.hasFiles()) throw new HandBackToRails("a post with files (UrlRedirect)");
  await railsCache().fetch(`post_email:${post.id}:${purchase.id}`, { expiresIn: RESEND_LIMIT_SECONDS }, async () => {
    // Taken before the send and dropped after it, so a post Node cannot render leaves them for Rails to clear.
    const earlier = await earlierEmailInfoIds(purchase.id, post.id);
    try {
      await processPostEmail(
        {
          post: sent,
          recipients: [
            {
              email: purchase.email!,
              purchase,
              ...(purchase.subscription_id === null ? {} : { subscription: { id: BigInt(purchase.subscription_id) } }),
            },
          ],
        },
        defaultPostEmailDeps(),
      );
    } catch (error) {
      if (error instanceof PostEmailNotPortedError) throw new HandBackToRails(error.message);
      await destroyEmailInfos(earlier);
      throw error;
    }
    await destroyEmailInfos(earlier);
    return true;
  });
  return noContent();
}

registerMutations({
  method: "POST",
  pattern: "/posts/:id/send_for_purchase/:purchase_id",
  json: true,
  run: sendForPurchase,
});
