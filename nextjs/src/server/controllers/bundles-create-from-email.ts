// BundlesController#create_from_email (GET /bundles/create_from_email, app/controllers/bundles_controller.rb): the bundle link the
// marketing email carries. Node answers the policy refusal and the links Rails cannot save (a type the email never sends, so no name,
// or a price under the seller's currency minimum) ahead of the first write, as the same redirect with an alert. Creating the bundle
// (the Link and Price rows and its bundle products) and a link without a whole-number price (Rails raises LinkInvalid, a 500) hand
// back whole.
import { Prisma } from "@prisma/client";

import LINK_DATA from "../models/link-data.generated.json" with { type: "json" };
import { column, selectRows, table } from "../models/sql.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const PRODUCTS_PATH = "/products";
const STALE_LINK = "This bundle link is no longer valid. Use New product to create a bundle.";
// Product::BundlesMarketing: YEAR_BUNDLE, BEST_SELLING_BUNDLE, EVERYTHING_BUNDLE
const MARKETING_BUNDLE_TYPES = ["year", "best_selling", "everything"];
const WHOLE_NUMBER = /^[0-9]{1,9}$/u;
const CURRENCIES = LINK_DATA.currencies as Record<string, { min_price: number }>;
const DEFAULT_CURRENCY = "usd";

async function createFromEmail(input: MutationInput): Promise<ActionResult> {
  const current: { seller: SellerContext["seller"] } = { seller: null };
  const denied = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (sellerContext) => authorize(linkPolicy.create, sellerContext),
    {
      afterAuthorize: (sellerContext) => {
        current.seller = sellerContext.seller;
      },
    },
  );
  if (denied) return denied;
  if (current.seller === null) throw new HandBackToRails("a request without a current seller");

  const { type, price } = input.params;
  if (typeof price !== "string" && typeof price !== "number") throw new HandBackToRails("a link without a price");
  const cents = typeof price === "number" ? String(price) : price;
  if (!WHOLE_NUMBER.test(cents)) throw new HandBackToRails("a price that is not a whole number");
  if (type !== undefined && typeof type !== "string") throw new HandBackToRails("a type that is not text");

  const [account] = await selectRows<{ currency_type: string | null }>(
    Prisma.sql`SELECT ${column("users", "currency_type")} FROM ${table("users")} WHERE ${column("users", "id")} = ${current.seller.id} LIMIT 1`,
  );
  const currency = CURRENCIES[account?.currency_type ?? DEFAULT_CURRENCY];
  if (currency === undefined) throw new HandBackToRails("a currency Rails has no configuration for");

  const named = typeof type === "string" && MARKETING_BUNDLE_TYPES.includes(type);
  if (named && Number(cents) >= currency.min_price) throw new HandBackToRails("creating the bundle");
  return { status: FOUND, location: PRODUCTS_PATH, flash: { alert: STALE_LINK } };
}

registerMutations({ method: "GET", pattern: "/bundles/create_from_email", skipForgeryProtection: true, run: createFromEmail });
