// LinksController#create (POST /links): the "What are you creating?" form. The seller's draft product is saved and they land on its editor.
// Whatever the model port does not prove (see models/link-create.ts) goes to Rails whole, before the first write.
import { Prisma } from "@prisma/client";

import {
  canCreatePhysicalProducts,
  createLink,
  errorsToHash,
  parseCreateParams,
  toSentence,
  type SellerAccount,
} from "../models/link-create.ts";
import { LinkInvalid } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { UserFlags } from "../models/user.ts";
import { createUserEvent } from "../page-props/audience/events.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./signed-in-filters.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const FORBIDDEN = 403;
// `head :forbidden` names the content type of the format asked for.
const FORMAT_CONTENT_TYPES = { html: "text/html", json: "application/json" } as const;
const NEW_PRODUCT_PATH = "/products/new";
const ADD_PRODUCT_EVENT = "add_product";

// `redirect_to new_product_path, alert:, inertia: { errors: }`
const refusal = (alert: string, errors: Record<string, string>): ActionResult => ({
  status: FOUND,
  location: NEW_PRODUCT_PATH,
  flash: { alert },
  inertiaErrors: errors,
});

async function create(input: MutationInput): Promise<ActionResult> {
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
  const sellerRow = current.seller;
  if (sellerRow === null) throw new HandBackToRails("a request without a current seller");

  // MobileAppWebView signs the WebView in from the request's token and records a second event for it.
  if (
    input.params.display !== undefined ||
    input.params.access_token !== undefined ||
    input.chain.session.data.mobile_app_web_view === true
  )
    throw new HandBackToRails("a request from the mobile app web view");

  const params = parseCreateParams(input.params.link);
  const isTeamMember = UserFlags.isSet(sellerRow.flags, "is_team_member");
  const [account] = await selectRows<{ json_data: string | null }>(
    Prisma.sql`SELECT ${column("users", "json_data")} FROM ${table("users")} WHERE ${column("users", "id")} = ${sellerRow.id} LIMIT 1`,
  );
  const seller: SellerAccount = {
    id: sellerRow.id,
    flags: sellerRow.flags,
    verified: sellerRow.verified,
    confirmed_at: sellerRow.confirmed_at,
    created_at: sellerRow.created_at,
    user_risk_state: sellerRow.user_risk_state,
    json_data: account?.json_data ?? null,
  };

  if (params.isPhysical && (await canCreatePhysicalProducts(seller, new Date())) === "forbidden") {
    const format = requestFormat(input.request);
    if (format !== "html" && format !== "json")
      throw new HandBackToRails("a request format head :forbidden has no content type for");
    return { status: FORBIDDEN, body: "", contentType: FORMAT_CONTENT_TYPES[format], paramsRead: true };
  }

  let outcome;
  try {
    outcome = await createLink({ ...seller, isTeamMember }, params);
  } catch (error) {
    // Link::LinkInvalid from the price assignment, rescued ahead of the save.
    if (!(error instanceof LinkInvalid)) throw error;
    return refusal(error.message, { "link.base": error.message });
  }
  if (!outcome.created) {
    const grouped = errorsToHash(outcome.errors);
    // A related record (a variant) failed: the product has no errors of its own, so there is no alert to show.
    if (grouped.length === 0) return { status: FOUND, location: NEW_PRODUCT_PATH, inertiaErrors: {} };
    return refusal(
      toSentence(grouped[0]![1]),
      Object.fromEntries(grouped.map(([attribute, messages]) => [`link.${attribute}`, toSentence(messages)])),
    );
  }

  await createUserEvent(ADD_PRODUCT_EVENT, {
    context: input.context,
    headers: input.request.headers,
    url: input.url,
    state: input.peekState(),
    params: input.params,
    product: { id: outcome.link.get("id"), price_cents: outcome.priceCents },
  });
  return {
    status: SEE_OTHER,
    location: `/products/${railsSegment(outcome.link.get("unique_permalink")!)}/edit`,
  };
}

registerMutations({ method: "POST", pattern: "/links", run: create });
