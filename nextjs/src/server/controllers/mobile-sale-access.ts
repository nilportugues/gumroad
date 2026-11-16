// Api::Mobile::SalesController#revoke_access and #undo_revoke_access: the seller toggles `is_access_revoked` on one of their sales
// from the app. The write is the one the customers page makes (purchase-access-writes.ts); only the envelope differs.
import { Prisma, type Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { accessRecord } from "../models/purchase-access-record.ts";
import { loadLibraryPurchase, setLibraryFlag } from "../models/purchase-library-writes.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";

import {
  fetchError,
  registerMobile,
  renderJson,
  UNAUTHORIZED,
  type MobileAuth,
  type MobileInput,
} from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];

// before_action :fetch_purchase: current_resource_owner.sales.find_by_external_id
async function findSale(input: MobileInput, auth: MobileAuth | null): Promise<Purchase | null> {
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
  );
  return row ? castRow<Purchase>("Purchase", row) : null;
}

const accessAction = (revoked: boolean, query: typeof audiencePurchasePolicy.revokeAccess) =>
  async function toggleAccess(input: MobileInput, auth: MobileAuth | null) {
    const sale = await findSale(input, auth);
    if (sale === null) return fetchError("Could not find purchase");

    // SalesController#seller_context: the token's owner acting on their own account.
    const context: SellerContext = { user: auth!.owner, seller: auth!.owner, memberships: [] };
    try {
      authorize(query, context, await accessRecord(sale));
    } catch (error) {
      // Unlike the before_action's 404, this render happens inside the action, so the after_actions still run.
      if (error instanceof NotAuthorizedError)
        return renderJson({ success: false, message: "Not authorized" }, UNAUTHORIZED);
      throw error;
    }

    await setLibraryFlag(loadLibraryPurchase(sale, auth!.owner.timezone), "is_access_revoked", revoked);
    return renderJson({ success: true });
  };

registerMobile(
  {
    method: "PUT",
    pattern: "/mobile/sales/:id/revoke_access",
    scopes: MOBILE_API_SCOPES,
    run: accessAction(true, audiencePurchasePolicy.revokeAccess),
  },
  {
    method: "PUT",
    pattern: "/mobile/sales/:id/undo_revoke_access",
    scopes: MOBILE_API_SCOPES,
    run: accessAction(false, audiencePurchasePolicy.undoRevokeAccess),
  },
);
