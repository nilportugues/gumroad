// PostsController#send_for_purchase (app/controllers/posts_controller.rb): the seller re-sending a post to one customer from the
// customers page.
//
// Served here: every answer before the send. The send clears the customer's email records, rate-limits through Rails.cache
// (memcached) and mails through PostEmailApi, so a request that would send goes to Rails whole, before any write.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { InstallmentFlags } from "../models/installment-post.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { eligibleToSendEmails } from "../models/user-email-eligibility.ts";
import { isSuspended, Users } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { authorize } from "../policies/authorize.ts";
import { installmentPolicy } from "../policies/installment.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { json, UNAUTHORIZED, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

type PostRow = { seller_id: bigint | null; flags: bigint | number | null };
type UserRow = Parameters<typeof Users.load>[0];

const isTrue = (value: unknown) => value === true || value === 1 || value === 1n;

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
          Prisma.sql`SELECT ${column("installments", "seller_id")}, ${column("installments", "flags")} FROM ${table("installments")} WHERE ${column("installments", "id")} = ${postId} LIMIT 1`,
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
      : await selectRows<{ can_contact: boolean | number | bigint | null }>(
          Prisma.sql`SELECT ${column("purchases", "can_contact")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "id")} = ${purchaseId} LIMIT 1`,
        );
  if (purchase === undefined) throw new RoutingError("Not Found");

  // The 404 for a single-recipient email sent to another purchase reads the post's JSON data, which is not ported.
  if (InstallmentFlags.isSet(post.flags ?? 0n, "single_recipient_email"))
    throw new HandBackToRails("a single-recipient email");
  if (!isTrue(purchase.can_contact))
    return json({ message: "This customer has unsubscribed from your emails." }, UNPROCESSABLE_ENTITY);
  throw new HandBackToRails("an email to send");
}

registerMutations({
  method: "POST",
  pattern: "/posts/:id/send_for_purchase/:purchase_id",
  json: true,
  run: sendForPurchase,
});
