// PostsController#redirect_from_purchase_id (app/controllers/posts_controller.rb): the legacy
// /library/purchase/:purchase_id/update/:id link in old post emails, redirected to the post page.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isSuspended, Users } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { authorize } from "../policies/authorize.ts";
import { installmentPolicy } from "../policies/installment.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import { cgiEscape, requestFormat } from "./rails-params.ts";
import { json, UNAUTHORIZED } from "./seller-json.ts";

type PostRow = { id: bigint; seller_id: bigint | null; link_id: bigint | null; slug: string | null };
type UserRow = Parameters<typeof Users.load>[0] & { username: string | null; external_id: string };

async function redirectFromPurchaseId(input: MutationInput): Promise<ActionResult> {
  const { request, context, routeParams } = input;
  if (railsLoggedInUser(context) === null || context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const format = requestFormat(request);
  if (format === "other") throw new HandBackToRails("a request whose format is neither HTML nor JSON");

  const sellerContext = await loadSellerContext(context);
  try {
    authorize(installmentPolicy.redirectFromPurchaseId, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    // PunditAuthorization#default_user_not_authorized
    const message = notAllowedMessage(sellerContext);
    if (format === "json") return { ...json({ success: false, error: message }, UNAUTHORIZED), rescued: true };
    const switching = request.queryString.includes("account_switched");
    return { status: 302, location: "/dashboard", ...(switching ? {} : { flash: { alert: message } }), rescued: true };
  }

  // fetch_post(false): a suspended owner hides the post.
  const id = decrypt(routeParams.id!);
  const [post] =
    id === null
      ? []
      : await selectRows<PostRow>(
          Prisma.sql`SELECT * FROM ${table("installments")} WHERE ${column("installments", "id")} = ${id} LIMIT 1`,
        );
  if (!post) throw new RoutingError("Not Found");
  // A post with only a product makes Rails raise NoMethodError (Link#seller), and a slug-less one fails the redirect.
  if (post.seller_id === null || post.slug === null || post.slug.trim() === "")
    throw new HandBackToRails("a post without a seller or a slug");
  const [owner] = await selectRows<UserRow>(
    Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${post.seller_id} LIMIT 1`,
  );
  if (!owner) throw new HandBackToRails("a post whose seller row is missing");
  if (isSuspended(Users.load(owner))) throw new RoutingError("Not Found");

  // build_view_post_route: `User#username` falls back to the external id; `purchase_id.presence` drops a blank one.
  const username = owner.username !== null && owner.username.trim() !== "" ? owner.username : owner.external_id;
  const purchaseId = routeParams.purchase_id!;
  const query = purchaseId.trim() === "" ? "" : `?purchase_id=${cgiEscape(purchaseId)}`;
  return { status: 302, location: `/${railsSegment(username)}/p/${railsSegment(post.slug)}${query}` };
}

registerMutations({
  method: "GET",
  pattern: "/library/purchase/:purchase_id/update/:id",
  skipForgeryProtection: true,
  run: redirectFromPurchaseId,
});
