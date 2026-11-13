// UsersController (app/controllers/users_controller.rb): the guards, redirects and small reads that need no rendered page.
//
// Ported: #edit (redirect to /profile, 404 for another account), #landing_version, the 404 of
// #landing_iframe_content and #landing_products for a seller whose custom HTML is not live, #deactivate's refusal of a non-owner, and the answers of #add_purchase_to_library that need no password or write.
// Handed to Rails before any write:
//   - #show (`/:username`): a single segment also matches taxonomy pages and Rails-only paths, and the route table has no way to fall
//     through to the next route when a name is not a profile, so listing it would shadow them. #subscribe_preview renders an Inertia page;
//   - #landing_iframe_content and #landing_products of a seller whose custom HTML is live (both render); #coffee is the Users/Coffee page
//     (page-props/storefront/profile-pages.ts);
//   - #deactivate by an owner (balance forfeit, sign out, soft delete);
//   - #add_purchase_to_library once a purchase would move (the logged-in write) or a password is checked (a user owns the email).
import { Prisma, type User } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isAccountActive, nameOrUsername, Users } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { setNoindexForUnprovenStorefront } from "../page-props/storefront/profile-pages.ts";
import { sellerOfHost } from "../page-props/storefront/seller-host.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { settingsProfilePolicy } from "../policies/settings/profile.ts";
import { userPolicy } from "../policies/user.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { customHtmlStoreHostnames, enqueueRoutabilityRefresh } from "../services/custom-domain-hosts.ts";
import { interpolateProfile } from "../services/pages-interpolator.ts";
import { referencedInPrices } from "../services/pages-product-prices.ts";
import { loadProfileDataFacts, profileDataJson } from "../services/pages-profile-data.ts";

import {
  HandBackToRails,
  RoutingError,
  type ActionResult,
  type Chain,
  type Rendered,
} from "./application-controller.ts";
import {
  customHtmlCsp,
  customHtmlNavigationBridgeScript,
  FOLLOW_BRIDGE_SCRIPT,
  pagesTailwindHead,
  PRODUCTS_BRIDGE_SCRIPT,
  profileCustomHtmlDocument,
} from "./custom-html-document.ts";
import { customHtmlProductsSlice } from "./custom-html-products-slice.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { isSellerHost, userPageEmbed, userPageVersion } from "./user-pages.ts";

const FOUND = 302;
const NOT_FOUND = 404;
const UNAUTHORIZED = 401;
const CUSTOM_HTML_FEATURE = "custom_html_pages";
const CLAIM_ERROR = "This is your customer's purchase, so it can't be moved into your account.";

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `head :not_found`: no body, typed by the format.
function headNotFound(input: MutationInput): Rendered {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a format whose content type is not modelled");
  return {
    status: NOT_FOUND,
    body: "",
    contentType: format === "json" ? "application/json" : "text/html",
    paramsRead: true,
  };
}

export function requireHtml(input: MutationInput): void {
  if (requestFormat(input.request) !== "html") throw new HandBackToRails("a request whose format is not HTML");
}

// CustomDomainConfig#set_user: `User.find_by(username:) || User.find_by(external_id:)`, then #error_if_user_not_found.
async function userByUsername(username: string): Promise<User | null> {
  return (
    (await db.user.findFirst({ where: { username }, orderBy: { id: "asc" } })) ??
    (await db.user.findFirst({ where: { external_id: username }, orderBy: { id: "asc" } }))
  );
}

const servable = (user: User | null): user is User =>
  user !== null && user.username !== null && isAccountActive(Users.load(user));

// #set_user_and_custom_domain_config for the route's host: `/:username/...` on the Gumroad domain, the seller's own host otherwise.
export async function profileUser(input: MutationInput): Promise<User> {
  const username = input.routeParams.username;
  if (username === undefined) return sellerOfHost(input.url);
  const user = await userByUsername(username);
  if (!servable(user)) throw new RoutingError("Not Found");
  return user;
}

// custom_landing_page_visible?: the root page has custom HTML and the seller has the feature.
async function customLandingPageVisible(
  seller: User,
): Promise<{ visible: boolean; updatedAt: Date | null; customHtml: string | null }> {
  const page = await db.page.findFirst({
    where: { pageable_type: "User", pageable_id: seller.id, slug: null },
    orderBy: { id: "asc" },
  });
  const present = page?.custom_html != null && page.custom_html.trim() !== "";
  const visible = present && (await isFeatureEnabled(CUSTOM_HTML_FEATURE, userActor(seller.id)));
  return {
    visible,
    updatedAt: visible ? (page.updated_at ?? null) : null,
    customHtml: visible ? page.custom_html : null,
  };
}

// Headers the filters wrote that a redirect has to carry.
const noindexHeaders = (chain: Chain): Record<string, string> => {
  const value = chain.headers.get("x-robots-tag");
  return value === null ? {} : { "x-robots-tag": value };
};

// GET /:username/edit and /edit
async function edit(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const { context } = input;
  const redirect = await sellerGuard(
    {
      context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    async (sellerContext) => {
      // `authenticate_user!` runs first, then the user lookup; `e404` precedes the policy.
      const user = await profileUser(input);
      if (user.id !== context.currentSeller?.id) throw new RoutingError("Not Found");
      authorize(settingsProfilePolicy.show, sellerContext);
    },
    { requireAccountEmail: false },
  );
  if (redirect !== null) return redirect;
  const config = domainConfig(process.env);
  return { status: FOUND, location: Routes.profile_url({ protocol: config.protocol, host: config.domain }) };
}

// GET /:username/landing/version and /landing/version
async function landingVersion(input: MutationInput): Promise<ActionResult> {
  // On a seller's host the same path is /:slug/landing/version of a slugged page.
  if (input.routeParams.username !== undefined && isSellerHost(input)) return userPageVersion(input);
  if (requestFormat(input.request) === "other")
    throw new HandBackToRails("a format whose content type is not modelled");
  const user = await profileUser(input).catch((error: unknown) => {
    if (error instanceof RoutingError && requestFormat(input.request) !== "html")
      throw new HandBackToRails("an unknown account requested as JSON");
    throw error;
  });
  const owner = input.context.currentSeller !== null && input.context.currentSeller.id === user.id;
  if (!owner) return json({ present: false, version: null });
  const { visible, updatedAt } = await customLandingPageVisible(user);
  return json({
    present: visible,
    version: visible && updatedAt !== null ? Math.floor(updatedAt.getTime() / 1000) : null,
  });
}

// The 404 of a seller whose custom HTML is not live, shared by the embed and the products slice.
function landingNotFound(input: MutationInput): ActionResult {
  return { ...headNotFound(input), headers: noindexHeaders(input.chain) };
}

// GET /:username/landing/embed and /landing/embed
async function landingEmbed(input: MutationInput): Promise<ActionResult> {
  if (input.routeParams.username !== undefined && isSellerHost(input)) return userPageEmbed(input);
  requireHtml(input);
  const user = await profileUser(input);
  await setNoindexForUnprovenStorefront(input.chain, user);
  const { visible, customHtml } = await customLandingPageVisible(user);
  if (!visible) return landingNotFound(input);

  // `params[:preview].present?`: only text is modelled.
  const preview = input.params.preview;
  if (preview !== undefined && typeof preview !== "string")
    throw new HandBackToRails("a preview parameter that is not text");
  const owner = input.context.currentSeller !== null && input.context.currentSeller.id === user.id;

  // Pages::ProductPrices.build is Rails' (visitor GeoIP and currency)
  if (referencedInPrices(customHtml)) throw new HandBackToRails("a page that references product prices");
  const interpolated = interpolateProfile(customHtml!, {
    profile: { name_or_username: nameOrUsername(Users.load(user)), bio: user.bio },
    prices: {},
  });
  const now = input.chain.now;
  const facts = await loadProfileDataFacts(
    { id: user.id, username: user.username, external_id: user.external_id },
    now,
  );
  const dataJson = profileDataJson(facts);

  const config = domainConfig(process.env);
  // profile_store_hostnames: the request host only when it is one of the seller's own
  const storeHostnames = await customHtmlStoreHostnames(user, now);
  const hostnames = [
    ...new Set([
      ...(config.validRequestHosts.includes(input.request.host) ? [] : [input.request.host]),
      ...storeHostnames,
    ]),
  ];
  const document = profileCustomHtmlDocument(interpolated, {
    dataJson,
    pricesJson: null,
    liveFields: isPresent(preview) && owner,
    navigationBridge: customHtmlNavigationBridgeScript(hostnames, config.validRequestHosts),
    followBridge: FOLLOW_BRIDGE_SCRIPT,
    productsBridge: PRODUCTS_BRIDGE_SCRIPT,
    tailwindHead: pagesTailwindHead(`${config.protocol}://${config.assetDomain}`),
  });
  await enqueueRoutabilityRefresh(facts.routabilityRefresh);
  return {
    status: 200,
    body: document,
    contentType: "text/html; charset=utf-8",
    paramsRead: true,
    optOutOfCsp: true,
    headers: {
      "Content-Security-Policy": customHtmlCsp(),
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  };
}

// GET /:username/landing/products and /landing/products: the 404 for a seller without live custom HTML, else a catalogue slice.
async function landingProducts(input: MutationInput): Promise<ActionResult> {
  if (input.routeParams.username !== undefined && isSellerHost(input))
    throw new HandBackToRails("a one-segment path under a seller's host that is not a page route");
  requireHtml(input);
  const user = await profileUser(input);
  const { visible, customHtml } = await customLandingPageVisible(user);
  if (!visible) return landingNotFound(input);
  return customHtmlProductsSlice(
    { id: user.id, username: user.username, external_id: user.external_id },
    customHtml,
    input.params,
    input.chain.now,
  );
}

// POST /users/deactivate
async function deactivate(input: MutationInput): Promise<ActionResult> {
  const sellerContext = await loadSellerContext(input.context);
  try {
    authorize(userPolicy.deactivate, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return { ...json({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
  }
  throw new HandBackToRails("an owner closing the account");
}

type PurchaseRow = {
  id: bigint;
  email: string | null;
  purchaser_id: bigint | null;
  link_id: bigint | null;
  flags: bigint | null;
};

// POST /add_purchase_to_library
async function addPurchaseToLibrary(input: MutationInput): Promise<ActionResult> {
  const failure = () => json({ success: false });
  const userParams = input.params.user;
  if (!isHash(userParams)) return failure();
  const { purchase_id: purchaseId, purchase_email: purchaseEmail, password } = userParams;
  // ObfuscateIds.decrypt reads `id.to_s`: the inspect string of a list or hash is not Base64, so the lookup finds no purchase and the
  // answer is the same failure whatever the other fields hold.
  if (Array.isArray(purchaseId) || isHash(purchaseId)) return failure();
  for (const value of [purchaseId, purchaseEmail, password]) {
    if (value !== undefined && value !== null && typeof value !== "string")
      throw new HandBackToRails("a parameter that is not text");
  }

  const id = typeof purchaseId === "string" ? decrypt(purchaseId) : null;
  const [purchase] =
    id === null
      ? []
      : await selectRows<PurchaseRow>(
          Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "email")}, ${column("purchases", "purchaser_id")}, ${column("purchases", "link_id")}, ${column("purchases", "flags")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (purchase === undefined) return failure();
  if (!sameBytes(purchase.email ?? "", text(purchaseEmail) ?? "")) return failure();
  if (PurchaseFlags.isSet(purchase.flags ?? 0n, "is_reassignment_locked")) return failure();

  if (purchase.link_id === null) throw new HandBackToRails("a purchase without a product");
  const product = await db.link.findUnique({ where: { id: purchase.link_id }, select: { user_id: true } });
  if (product === null) throw new HandBackToRails("a purchase whose product is gone");
  // Purchase#is_test_purchase?: `link.user == purchaser`, so two nils count as equal.
  const testPurchase =
    (product.user_id === null ? null : BigInt(product.user_id)) ===
    (purchase.purchaser_id === null ? null : BigInt(purchase.purchaser_id));
  if (testPurchase) return failure();

  const visitor = railsLoggedInUser(input.context);
  if (visitor !== null) {
    // Purchase#claim_by_seller?
    const claimed =
      product.user_id !== null &&
      BigInt(product.user_id) === BigInt(visitor.id) &&
      (purchase.purchaser_id !== null || (purchase.email ?? "").toLowerCase() !== (visitor.email ?? "").toLowerCase());
    if (claimed) return json({ success: false, error_message: CLAIM_ERROR });
    throw new HandBackToRails("a purchase moved into the visitor's library");
  }
  // `User.alive.find_by(email: purchase.email)`; a nil email would match accounts without one.
  if (!isPresent(purchase.email ?? "")) throw new HandBackToRails("a purchase without an email");
  const owner = await db.user.findFirst({ where: { email: purchase.email!, deleted_at: null }, select: { id: true } });
  if (owner !== null) throw new HandBackToRails("an account whose password is checked");
  return failure();
}

// ActiveSupport::SecurityUtils.secure_compare
const sameBytes = (a: string, b: string) => Buffer.from(a).equals(Buffer.from(b));

registerMutations(
  { method: "GET", pattern: "/:username/edit", skipForgeryProtection: true, run: edit },
  { method: "GET", pattern: "/edit", skipForgeryProtection: true, run: edit },
  { method: "GET", pattern: "/:username/landing/version", skipForgeryProtection: true, run: landingVersion },
  { method: "GET", pattern: "/landing/version", skipForgeryProtection: true, run: landingVersion },
  { method: "GET", pattern: "/:username/landing/embed", skipForgeryProtection: true, run: landingEmbed },
  { method: "GET", pattern: "/landing/embed", skipForgeryProtection: true, run: landingEmbed },
  { method: "GET", pattern: "/:username/landing/products", skipForgeryProtection: true, run: landingProducts },
  { method: "GET", pattern: "/landing/products", skipForgeryProtection: true, run: landingProducts },
  { method: "POST", pattern: "/users/deactivate", formats: ["json"], run: deactivate },
  { method: "POST", pattern: "/add_purchase_to_library", formats: ["any"], run: addPurchaseToLibrary },
);
