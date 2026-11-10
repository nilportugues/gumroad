// PurchasesController#revoke_access and #undo_revoke_access (app/controllers/purchases_controller.rb): the customers page's
// "Revoke access" toggle. Each flips `is_access_revoked` on the seller's own purchase and answers 204; no processor is called.
import { Prisma, type Link, type Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { LinkFlags } from "../models/link.ts";
import { loadLibraryPurchase, setLibraryFlag } from "../models/purchase-library-writes.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { type AccessRecord, audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { type ActionResult, HandBackToRails, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, noContent, notFoundJson } from "./seller-json.ts";

// `Purchase.find_by_external_id(params[:id]) || e404`
async function setPurchase(externalId: string): Promise<Purchase> {
  const id = decrypt(externalId);
  const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`);
  if (!row) throw new RoutingError("Not Found");
  return castRow<Purchase>("Purchase", row);
}

async function accessRecord(purchase: Purchase): Promise<AccessRecord> {
  const [link] = await selectRows<Link>(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${purchase.link_id} LIMIT 1`);
  const [subscription] =
    purchase.subscription_id == null ? [] : await selectRows(Prisma.sql`SELECT ${column("subscriptions", "id")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${purchase.subscription_id} LIMIT 1`);
  return {
    accessRevoked: PurchaseFlags.isSet(purchase.flags, "is_access_revoked"),
    refunded: purchase.stripe_refunded === true || (purchase.stripe_refunded as unknown) === 1,
    hasSubscription: subscription !== undefined,
    linkIsPhysical() {
      if (!link) throw new TypeError("undefined method 'is_physical' for nil");
      return LinkFlags.isSet(link.flags, "is_physical");
    },
  };
}

function accessAction(revoked: boolean, query: typeof audiencePurchasePolicy.revokeAccess) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const seller = input.context.currentSeller;
    if (railsLoggedInUser(input.context) === null || seller === null) throw new HandBackToRails("a signed-out request");

    const purchase = await setPurchase(input.routeParams.id!);
    // verify_current_seller_is_seller_for_purchase
    if (purchase.seller_id !== seller.id) return notFoundJson();
    const record = await accessRecord(purchase);
    const denied = await authorizeJson(input, (context) => authorize(query, context, record));
    if (denied) return denied;

    await setLibraryFlag(loadLibraryPurchase(purchase, seller.timezone), "is_access_revoked", revoked);
    return noContent();
  };
}

registerMutations(
  { method: "PUT", pattern: "/purchases/:id/revoke_access", json: true, run: accessAction(true, audiencePurchasePolicy.revokeAccess) },
  { method: "PUT", pattern: "/purchases/:id/undo_revoke_access", json: true, run: accessAction(false, audiencePurchasePolicy.undoRevokeAccess) },
);
