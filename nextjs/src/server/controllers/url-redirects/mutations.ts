// UrlRedirectsController's posts (#confirm, #change_purchaser, #save_last_content_page) and ConsumptionAnalyticsController#create.
import { timingSafeEqual } from "node:crypto";

import { PurchaseFlags } from "../../search/flags.ts";
import { changePurchaser, saveLastContentPageId } from "../../models/purchase-delivery-writes.ts";
import { domainConfig } from "../../page-props/domain.ts";
import { HandBackToRails, RoutingError, type ActionOptions, type ActionResult } from "../application-controller.ts";
import { json } from "../json-actions.ts";
import { registerMutations, type MutationInput } from "../mutation.ts";
import { isPresent } from "../rails-request.ts";
import { safeRedirectPath } from "../rails-params.ts";
import { appLoginRedirect, checkPermissions, claimBySeller, confirmedRedirectCookie, isTestPurchase, loadRedirect, redirectPaths, requireSellerForTestPurchase, viewerOf, type Loaded } from "./access.ts";
import { recordConsumptionEvent } from "./consumption-analytics.ts";
import { sendToKindle } from "./kindle.ts";

const FOUND = 302;
const UNPROCESSABLE_ENTITY = 422;
// UrlRedirectsController::MAX_CONTENT_PAGE_ID_LENGTH
const MAX_CONTENT_PAGE_ID_LENGTH = 64;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const present = (value: unknown): value is string => typeof value === "string" && isPresent(value);
const redirectTo = (location: string, flash?: Record<string, string>, cookies?: string[]): ActionResult => ({ status: FOUND, location, ...(flash ? { flash } : {}), ...(cookies ? { cookies } : {}) });

// ActiveSupport::SecurityUtils.secure_compare
function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// String#downcase, then ASCII-only String#casecmp (what `casecmp(...).zero?` compares by).
const asciiLower = (value: string) => value.replace(/[A-Z]/gu, (char) => char.toLowerCase());

const requireParam = (input: MutationInput) => input.routeParams.id!;

// before_action :fetch_url_redirect, then :check_permissions
async function authorized(input: MutationInput, actionName: string): Promise<{ loaded: Loaded } | { halted: ActionResult }> {
  const loaded = await loadRedirect(requireParam(input));
  const halted = await checkPermissions({ loaded, action: input, actionName });
  return halted ? { halted } : { loaded };
}

async function saveLastContentPage(input: MutationInput): Promise<ActionResult> {
  const gate = await authorized(input, "save_last_content_page");
  if ("halted" in gate) return gate.halted;
  const { purchase } = gate.loaded;
  if (!purchase) return json({ success: false, error: "Purchase not found" }, UNPROCESSABLE_ENTITY);

  const pageId = input.params.page_id;
  const valid = pageId === undefined || pageId === null || (typeof pageId === "string" && pageId.length <= MAX_CONTENT_PAGE_ID_LENGTH);
  if (!valid) return json({ success: false, error: "Invalid page" }, UNPROCESSABLE_ENTITY);

  await saveLastContentPageId(purchase, pageId ?? null);
  return json({ success: true });
}

// UrlRedirectsController#check_purchaser renders an ERB form, so only fetch_url_redirect's 404 is answered here.
async function checkPurchaser(input: MutationInput): Promise<ActionResult> {
  await loadRedirect(requireParam(input));
  throw new HandBackToRails("the change purchaser form, an ERB view");
}

async function confirm(input: MutationInput): Promise<ActionResult> {
  const loaded = await loadRedirect(text(input.params.id) ?? "");
  const { redirect, purchase } = loaded;
  const token = redirect.token ?? "";
  const display = text(input.params.display);
  const forwardable = isPresent(display) ? { display } : {};
  const destination = input.params.destination;

  if (requireSellerForTestPurchase(loaded, input) === "forbidden") {
    return appLoginRedirect(redirectPaths.confirm({ id: token, destination: text(destination) ?? null, ...forwardable }));
  }
  if (!purchase) throw new TypeError("undefined method 'email' for nil");

  const given = asciiLower((text(input.params.email) ?? "").trim().toLowerCase());
  if (asciiLower(purchase.email ?? "") === given) {
    const cookies = [confirmedRedirectCookie(token)];
    if (destination === "download_page") return redirectTo(redirectPaths.downloadPage(token, forwardable), undefined, cookies);
    if (destination === "stream") return redirectTo(redirectPaths.stream(token, forwardable), undefined, cookies);
    if (destination === "play") return redirectTo(redirectPaths.play(token), undefined, cookies);
    return redirectTo(redirectPaths.download(token, forwardable), undefined, cookies);
  }
  return redirectTo(redirectPaths.confirm({ id: token, ...forwardable }), { alert: "Wrong email. Please try again." });
}

// redirect_to_next
function redirectToNext(input: MutationInput): ActionResult {
  const next = text(input.params.next);
  if (!present(next)) return redirectTo("/");
  return redirectTo(safeRedirectPath(next, input.request, { rootDomain: domainConfig(process.env).rootDomain }));
}

async function changePurchaserAction(input: MutationInput): Promise<ActionResult> {
  const loaded = await loadRedirect(requireParam(input));
  // before_action :require_seller_for_test_purchase
  if (requireSellerForTestPurchase(loaded, input) === "forbidden") throw new RoutingError("Not Found");
  const { redirect, purchase } = loaded;
  const token = redirect.token ?? "";
  const next = text(input.params.next);
  const checkPurchaser = redirectPaths.checkPurchaser(token, present(next) ? next : null);

  const email = input.params.email;
  if (email !== undefined && email !== null && typeof email !== "string") throw new HandBackToRails("an email that is not a string");
  const wrongEmail = redirectTo(checkPurchaser, { alert: "Please enter the correct email address used to purchase this product" });
  if (!present(email)) return wrongEmail;
  if (!purchase) throw new TypeError("undefined method 'email' for nil");
  if (!secureCompare(email.trim().toLowerCase(), (purchase.email ?? "").trim().toLowerCase())) return wrongEmail;
  if (PurchaseFlags.isSet(purchase.flags, "is_reassignment_locked")) {
    return redirectTo(checkPurchaser, { alert: "This purchase is under review and cannot be moved to another account. Please contact support for help." });
  }
  const { loggedInUser } = viewerOf(input);
  if (loggedInUser === null) return appLoginRedirect(checkPurchaser);
  if (claimBySeller(loaded, loggedInUser, isTestPurchase(loaded))) return redirectTo(checkPurchaser, { alert: "This is your customer's purchase, so it can't be moved into your account." });

  await changePurchaser(purchase, loggedInUser.id);
  return redirectToNext(input);
}

const SKIP_SUSPENSION_CHECK: ActionOptions = { skip: ["check_suspended"] };

registerMutations(
  { method: "GET", pattern: "/r/:id/check_purchaser", skipForgeryProtection: true, run: checkPurchaser },
  { method: "POST", pattern: "/r/:id/save_last_content_page", formats: ["any"], run: saveLastContentPage },
  { method: "POST", pattern: "/r/:id/send_to_kindle", formats: ["any"], run: sendToKindle },
  { method: "POST", pattern: "/confirm-redirect", options: SKIP_SUSPENSION_CHECK, run: confirm },
  { method: "POST", pattern: "/r/:id/change_purchaser", run: changePurchaserAction },
  // skip_before_action :check_suspended
  { method: "POST", pattern: "/consumption_analytics", formats: ["any"], options: SKIP_SUSPENSION_CHECK, run: async (input) => json({ success: await recordConsumptionEvent(input.params, input.request.headers) }) },
);
