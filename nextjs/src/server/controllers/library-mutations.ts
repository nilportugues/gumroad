// LibraryController#archive, #unarchive and #delete (app/controllers/library_controller.rb).
import { Prisma, type Purchase, type User } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { type LibraryFlag, loadLibraryPurchase, setLibraryFlag } from "../models/purchase-library-writes.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { purchasePolicy } from "../policies/buyer.ts";

import { RoutingError, type ActionOptions, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const SEE_OTHER = 303;

// `skip_before_action :check_suspended`
const OPTIONS: ActionOptions = { skip: ["check_suspended"] };

// `logged_in_user.purchases.find_by_external_id!(params[:id])`
async function setPurchase(buyer: User, externalId: string): Promise<Purchase> {
  const id = decrypt(externalId);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${buyer.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  return castRow<Purchase>("Purchase", row);
}

function libraryAction(flag: LibraryFlag, value: boolean, notice: string, query: typeof purchasePolicy.archive) {
  return async (input: MutationInput): Promise<ActionResult> => {
    let purchase: Purchase | null = null;
    const denied = await sellerGuard(
      {
        context: input.context,
        config: domainConfig(process.env),
        url: input.url,
        params: input.routeParams,
        urlOptions: input.urlOptions,
      },
      async (sellerContext) => {
        // set_purchase is a before_action, so a purchase that is not the buyer's is a 404 before `authorize @purchase`.
        purchase = await setPurchase(railsLoggedInUser(input.context)!, input.routeParams.id!);
        authorize(query, sellerContext);
      },
    );
    if (denied) return denied;

    const [seller] = await selectRows<User>(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${purchase!.seller_id} LIMIT 1`,
    );
    if (!seller) throw new TypeError("undefined method 'timezone' for nil");
    await setLibraryFlag(loadLibraryPurchase(purchase!, seller.timezone), flag, value);
    return { status: SEE_OTHER, location: Routes.library_path(), flash: { notice } };
  };
}

registerMutations(
  {
    method: "PATCH",
    pattern: "/library/purchase/:id/archive",
    options: OPTIONS,
    run: libraryAction("is_archived", true, "Product archived!", purchasePolicy.archive),
  },
  {
    method: "PATCH",
    pattern: "/library/purchase/:id/unarchive",
    options: OPTIONS,
    run: libraryAction("is_archived", false, "Product unarchived!", purchasePolicy.unarchive),
  },
  {
    method: "PATCH",
    pattern: "/library/purchase/:id/delete",
    options: OPTIONS,
    run: libraryAction("is_deleted_by_buyer", true, "Removed from your library!", purchasePolicy.delete),
  },
);
