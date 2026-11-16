// BundlesController#create_from_email (GET /bundles/create_from_email, app/controllers/bundles_controller.rb): the bundle link the
// marketing email carries. Node answers the policy refusal, the links Rails cannot save (a type the email never sends, so no name; a
// price under the seller's currency minimum, over the unverified maximum or a product a bundle cannot hold) ahead of the first write
// as the redirect with an alert, and creates the draft bundle (Link, Price and bundle product rows) otherwise. A link without a
// whole-number price (Rails raises LinkInvalid, a 500), a products
// parameter that is not a list of text and a product with SKUs hand back whole.
import { Prisma } from "@prisma/client";

import { encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { bundleMarketingNames, createBundleFromEmail } from "../models/link-create.ts";
import LINK_DATA from "../models/link-data.generated.json" with { type: "json" };
import { column, selectRows, table } from "../models/sql.ts";
import { UserFlags } from "../models/user.ts";
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
const WHOLE_NUMBER = /^[0-9]{1,9}$/u;
const CURRENCIES = LINK_DATA.currencies as Record<string, { min_price: number }>;
const DEFAULT_CURRENCY = "usd";

const stale = (): ActionResult => ({ status: FOUND, location: PRODUCTS_PATH, flash: { alert: STALE_LINK } });

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
  const digits = typeof price === "number" ? String(price) : price;
  if (!WHOLE_NUMBER.test(digits)) throw new HandBackToRails("a price that is not a whole number");
  if (type !== undefined && typeof type !== "string") throw new HandBackToRails("a type that is not text");

  const [account] = await selectRows<{ currency_type: string | null; json_data: string | null }>(
    Prisma.sql`SELECT ${column("users", "currency_type")}, ${column("users", "json_data")} FROM ${table("users")} WHERE ${column("users", "id")} = ${current.seller.id} LIMIT 1`,
  );
  const currencyType = account?.currency_type ?? DEFAULT_CURRENCY;
  const currency = CURRENCIES[currencyType];
  if (currency === undefined) throw new HandBackToRails("a currency Rails has no configuration for");

  const { products } = input.params;
  if (products !== undefined && (!Array.isArray(products) || products.some((id) => typeof id !== "string")))
    throw new HandBackToRails("products that are not a list of text");

  const name = typeof type === "string" ? bundleMarketingNames(new Date())[type] : undefined;
  if (name === undefined) return stale();
  const cents = Number(digits);
  // price_must_be_within_range lets a price of zero through.
  if (cents !== 0 && cents < currency.min_price) return stale();

  const sellerRow = current.seller;
  const outcome = await createBundleFromEmail(
    {
      id: sellerRow.id,
      flags: sellerRow.flags,
      verified: sellerRow.verified,
      confirmed_at: sellerRow.confirmed_at,
      created_at: sellerRow.created_at,
      user_risk_state: sellerRow.user_risk_state,
      json_data: account?.json_data ?? null,
      isTeamMember: UserFlags.isSet(sellerRow.flags, "is_team_member"),
    },
    { name, priceCents: cents, currency: currencyType, externalIds: (products as string[] | undefined) ?? [] },
  );
  if (!outcome.created) return stale();
  return { status: FOUND, location: `/bundles/${externalId(outcome.link.get("id"))}/product/edit` };
}

registerMutations({
  method: "GET",
  pattern: "/bundles/create_from_email",
  skipForgeryProtection: true,
  run: createFromEmail,
});
