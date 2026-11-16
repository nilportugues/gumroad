// AffiliateRequests::OnboardingFormController#update (app/controllers/affiliate_requests/onboarding_form_controller.rb): the sign-in
// check and the refusal of a form that turns every product off while requests are pending.
//
// The action's own `rescue => e` swallows Pundit::NotAuthorizedError and the NoMethodError of a missing products list, so a role that
// cannot update and a body without products both land on the same "Something went wrong" redirect, not on the dashboard.
//
// Handed to Rails whole before any write: a form that keeps a product enabled (the bulk upsert and the seller flag), a request that
// is not an Inertia visit (it answers JSON), and a body whose shape the controller's rescue clauses would answer.
import { Prisma } from "@prisma/client";

import { encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { affiliateRequestPolicy } from "../policies/affiliate-request.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const ONBOARDING_PATH = "/affiliates/onboarding";
const SOMETHING_WENT_WRONG = "Something went wrong";
const PENDING_REQUESTS_ALERT =
  "You need to have at least one product enabled since there are some pending affiliate requests";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `current_seller.links.alive`, as the numbers the form sends their ids as (`external_id_numeric`).
async function publishedProductIds(sellerId: bigint): Promise<Set<number>> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL`,
  );
  return new Set(rows.map((row) => encryptNumeric(Number(row.id))));
}

// `seller.affiliate_requests.unattended_or_approved_but_awaiting_requester_to_sign_up.any?`
async function hasPendingRequests(sellerId: bigint): Promise<boolean> {
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("affiliate_requests")} LEFT OUTER JOIN ${table("users")} ON ${column("users", "email")} = ${column("affiliate_requests", "email")} WHERE ${column("affiliate_requests", "seller_id")} = ${sellerId} AND ((${column("users", "id")} IS NULL AND ${column("affiliate_requests", "state")} = 'approved') OR ${column("affiliate_requests", "state")} = 'created') LIMIT 1`,
  );
  return row !== undefined;
}

// PATCH|PUT /affiliate_requests/onboarding_form
async function update(input: MutationInput): Promise<ActionResult> {
  let allowed = false;
  const redirect = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (context) => {
      allowed = affiliateRequestPolicy.update(context);
    },
  );
  if (redirect !== null) return redirect;
  if (!input.request.headers.has("x-inertia")) throw new HandBackToRails("a form post that answers JSON");
  const wrong: ActionResult = { status: FOUND, location: ONBOARDING_PATH, flash: { alert: SOMETHING_WENT_WRONG } };
  if (!allowed) return wrong;

  const products = input.params.products;
  if (products === undefined || products === null) return wrong;
  if (!Array.isArray(products) || !products.every(isHash))
    throw new HandBackToRails("products that are not a list of hashes, which the controller's rescue answers");
  const published = await publishedProductIds(input.context.currentSeller!.id);
  const ofSeller = products.filter((product) => published.has(rubyToI(product.id)));
  for (const product of ofSeller) {
    if (isHash(product.enabled) || Array.isArray(product.enabled))
      throw new HandBackToRails("an enabled flag that is not a scalar");
  }
  // Ruby truthiness: only nil and false are off, so the text "false" keeps a product enabled.
  const anyEnabled = ofSeller.some(
    (product) => product.enabled !== undefined && product.enabled !== null && product.enabled !== false,
  );
  if (!anyEnabled && (await hasPendingRequests(input.context.currentSeller!.id)))
    return { status: FOUND, location: ONBOARDING_PATH, flash: { alert: PENDING_REQUESTS_ALERT } };
  throw new HandBackToRails("saving the self-service affiliate products, which writes them and the seller's flag");
}

registerMutations(
  { method: "PATCH", pattern: "/affiliate_requests/onboarding_form", run: update },
  { method: "PUT", pattern: "/affiliate_requests/onboarding_form", run: update },
);
