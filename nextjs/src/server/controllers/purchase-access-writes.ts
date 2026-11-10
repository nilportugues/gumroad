// PurchasesController#revoke_access and #undo_revoke_access (app/controllers/purchases_controller.rb): the customers page's
// "Revoke access" toggle. Each flips `is_access_revoked` on the seller's own purchase and answers 204; no processor is called.
import { Prisma, type Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { accessRecord } from "../models/purchase-access-record.ts";
import { loadLibraryPurchase, setLibraryFlag } from "../models/purchase-library-writes.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";

import { type ActionResult, HandBackToRails, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, noContent, notFoundJson } from "./seller-json.ts";

// `Purchase.find_by_external_id(params[:id]) || e404`
async function setPurchase(externalId: string): Promise<Purchase> {
  const id = decrypt(externalId);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  return castRow<Purchase>("Purchase", row);
}

function accessAction(revoked: boolean, query: typeof audiencePurchasePolicy.revokeAccess) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const seller = input.context.currentSeller;
    if (railsLoggedInUser(input.context) === null || seller === null) throw new HandBackToRails("a signed-out request");

    const purchase = await setPurchase(input.routeParams.id!);
    // verify_current_seller_is_seller_for_purchase
    // A before_action halts the chain, so the after_actions (the XSRF cookie) do not run.
    if (purchase.seller_id !== seller.id) return { ...notFoundJson(), rescued: true };
    const record = await accessRecord(purchase);
    const denied = await authorizeJson(input, (context) => authorize(query, context, record));
    if (denied) return denied;

    await setLibraryFlag(loadLibraryPurchase(purchase, seller.timezone), "is_access_revoked", revoked);
    return noContent();
  };
}

registerMutations(
  {
    method: "PUT",
    pattern: "/purchases/:id/revoke_access",
    json: true,
    run: accessAction(true, audiencePurchasePolicy.revokeAccess),
  },
  {
    method: "PUT",
    pattern: "/purchases/:id/undo_revoke_access",
    json: true,
    run: accessAction(false, audiencePurchasePolicy.undoRevokeAccess),
  },
);
