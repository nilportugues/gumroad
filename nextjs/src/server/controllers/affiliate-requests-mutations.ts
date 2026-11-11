// AffiliateRequestsController (app/controllers/affiliate_requests_controller.rb): the guards, redirects and refusals that need no
// rendered page, mail or job.
//
// Ported: #new's 301 to the seller's subdomain and its 404 (the page itself is `seller:/affiliates` in the page registry); #create's 404 and the redirect with the validation errors;
// #update's 404, authorization and the "already processed" and "not a valid action" redirects; the 404 and sign-in redirect of
// #approve and #ignore; #approve_all with nothing pending.
// Handed to Rails before any write:
//   - #create of a valid request (the insert, the submission mails, and `approve!` when the seller auto-approves);
//   - #update, #approve, #ignore and #approve_all that would transition a request (the requester's affiliate record, the mails);
//   - #approve and #ignore render the `email_link_status` ERB view, which has no HTML shell in Node.
import type { AffiliateRequest, User } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import {
  AffiliateRequests,
  ACTION_APPROVE,
  ACTION_IGNORE,
  canPerformAction,
  hasEnabledSelfServiceProducts,
  hasUnattendedRequests,
  sellerRequestById,
} from "../models/affiliate-request.ts";
import { subdomainWithProtocol, Users } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { affiliateRequestPolicy } from "../policies/affiliate-request.ts";
import { authorize } from "../policies/authorize.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { profileUser, requireHtml } from "./users-controller.ts";

const MOVED_PERMANENTLY = 301;
const FOUND = 302;
const SEE_OTHER = 303;
// affiliates_path and custom_domain_new_affiliate_request_path
const AFFILIATES_PATH = "/affiliates";
const NOT_A_HASH = "affiliate_request is missing or not a hash, which params.require turns into a 400 or a 500";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Array#to_sentence
function toSentence(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// `params.require(:affiliate_request).permit(...)`: a scalar is kept, a hash or an array is filtered out as nil.
function permittedParams(input: MutationInput, keys: string[]): Record<string, string | null> {
  const value = input.params.affiliate_request;
  if (!isHash(value) || Object.keys(value).length === 0) throw new HandBackToRails(NOT_A_HASH);
  return Object.fromEntries(
    keys.map((key) => {
      const entry = value[key];
      if (typeof entry === "string") return [key, entry];
      if (typeof entry === "number" || typeof entry === "boolean")
        throw new HandBackToRails("a parameter that is not text, which Rails casts");
      return [key, null];
    }),
  );
}

// `ensure_creator_has_enabled_affiliate_requests`
async function requireEnabled(user: User): Promise<void> {
  if (!(await hasEnabledSelfServiceProducts(user.id))) throw new RoutingError("Not Found");
}

// GET /:username/affiliates
async function newRequest(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const user = await profileUser(input);
  // check_if_needs_redirect: the Gumroad domain sends the seller to their subdomain. A seller served here has a username, so
  // `subdomain` is never nil; the page itself is only rendered on the seller's own host.
  const subdomain = subdomainWithProtocol(Users.load(user));
  if (subdomain === null) throw new HandBackToRails("the AffiliateRequests/New page of a seller without a subdomain");
  return { status: MOVED_PERMANENTLY, location: `${subdomain}${AFFILIATES_PATH}`, rescued: true };
}

// POST /affiliate_requests on the seller's own host
async function create(input: MutationInput): Promise<ActionResult> {
  const user = await profileUser(input);
  if (user.username === null) throw new RoutingError("Not Found");
  await requireEnabled(user);

  const { name, email, promotion_text: promotionText } = permittedParams(input, ["name", "email", "promotion_text"]);
  const request = AffiliateRequests.build({
    seller_id: user.id,
    name: name as string,
    email: email as string,
    promotion_text: promotionText as string,
  });
  if (await AffiliateRequests.valid(request))
    throw new HandBackToRails("a valid affiliate request, which is saved and mailed");
  return {
    status: FOUND,
    location: AFFILIATES_PATH,
    flash: { alert: toSentence(request.errors.fullMessages()) },
  };
}

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

// authenticate_user!, then `current_seller.affiliate_requests.find_by_external_id!` and, for #update, `authorize`.
async function findOwnRequest(input: MutationInput, authorize_update = false) {
  const holder: { request: AffiliateRequest | null } = { request: null };
  const redirect = await sellerGuard(
    guardInput(input),
    async (sellerContext) => {
      const id = decrypt(input.routeParams.id!);
      holder.request = id === null ? null : await sellerRequestById(sellerContext.seller!.id, BigInt(id));
      if (holder.request === null) throw new RoutingError("Not Found");
      if (authorize_update) authorize(affiliateRequestPolicy.update, sellerContext);
    },
    { requireAccountEmail: false },
  );
  return { redirect, request: holder.request! };
}

const alert = (message: string): ActionResult => ({
  status: FOUND,
  location: AFFILIATES_PATH,
  flash: { alert: message },
});

// PATCH|PUT /affiliate_requests/:id
async function update(input: MutationInput): Promise<ActionResult> {
  const { redirect, request } = await findOwnRequest(input, true);
  if (redirect !== null) return redirect;

  const { action } = permittedParams(input, ["action"]);
  const actionName = action ?? "";
  if (!(await canPerformAction(request, actionName)))
    return alert(`${request.name}'s affiliate request has been already processed.`);
  if (actionName === ACTION_APPROVE || actionName === ACTION_IGNORE)
    throw new HandBackToRails("a transition, which mails and creates affiliates");
  return alert(`${actionName} is not a valid affiliate request action`);
}

// GET /affiliate_requests/:id/approve and /ignore
async function emailLink(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const { redirect } = await findOwnRequest(input);
  if (redirect !== null) return redirect;
  throw new HandBackToRails("the email_link_status page, and the transition behind it");
}

// POST /affiliate_requests/approve_all
async function approveAll(input: MutationInput): Promise<ActionResult> {
  const redirect = await sellerGuard(
    guardInput(input),
    (sellerContext) => authorize(affiliateRequestPolicy.approve_all, sellerContext),
    { requireAccountEmail: false },
  );
  if (redirect !== null) return redirect;
  if (await hasUnattendedRequests(input.context.currentSeller!.id))
    throw new HandBackToRails("approving pending requests, which mails and creates affiliates");
  return {
    status: SEE_OTHER,
    location: AFFILIATES_PATH,
    flash: { notice: "Approved all pending affiliate requests!" },
  };
}

registerMutations(
  { method: "GET", pattern: "/:username/affiliates", skipForgeryProtection: true, run: newRequest },
  { method: "POST", pattern: "/affiliate_requests", run: create },
  { method: "PATCH", pattern: "/affiliate_requests/:id", run: update },
  { method: "PUT", pattern: "/affiliate_requests/:id", run: update },
  { method: "GET", pattern: "/affiliate_requests/:id/approve", skipForgeryProtection: true, run: emailLink },
  { method: "GET", pattern: "/affiliate_requests/:id/ignore", skipForgeryProtection: true, run: emailLink },
  { method: "POST", pattern: "/affiliate_requests/approve_all", run: approveAll },
);
