// UrlRedirectsController#send_to_kindle. A signed-in buyer's kindle_email is saved on their user (a full User save), which stays with
// Rails; so does a stamped PDF. Everything a signed-out request, or any request Rails refuses, goes through is here.
import { currentJobsRuntime } from "../../models/concerns/job-runtime.ts";
import { canSendToKindle } from "../../models/product-file.ts";
import { deliverLater } from "../../mail/active-job.ts";
import { mailRoute } from "../../mail/delivery.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { json } from "../json-actions.ts";
import { isPresent } from "../rails-request.ts";
import type { MutationInput } from "../mutation.ts";
import { CONFIRMED_REDIRECT_COOKIE, createConsumptionEvent, grantsAccess, isTestPurchase, isTeamMember, loadRedirect, requestIp, testPurchaseViewer, viewerOf, viewerOwnsSubscription } from "./access.ts";
import { aliveProductFiles } from "./files.ts";
import { findFile } from "./streaming.ts";
import { readEncryptedCookie } from "../../auth/rails-cookies.ts";
import { railsCookieSecrets } from "../../auth/rails-session-config.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";

const NOT_FOUND = 404;
const UNPROCESSABLE_ENTITY = 422;
const CUSTOMER_MAILER = "CustomerMailer";
const INVALID_KINDLE_EMAIL = "Please enter a valid Kindle email address";
// KINDLE_EMAIL_REGEX (config/initializers/aws.rb): 3 to 255 characters, no leading or doubled dots in the local part, @kindle.com
const KINDLE_EMAIL = /^(?=[^]{3,255}$)([^@\s()[\],.<>;:\\"]+(\.[^@\s()[\],.<>;:\\"]+)*)@kindle\.com$/iu;

const notFound = () => json({ success: false, error: "Not found" }, NOT_FOUND);

export async function sendToKindle(input: MutationInput): Promise<ActionResult> {
  const loaded = await loadRedirect(input.routeParams.id!);
  const { redirect, purchase, purchaser, subscription } = loaded;
  const email = input.params.email;
  if (email === undefined || email === null || email === "" || (typeof email === "string" && !isPresent(email))) return json({ success: false, error: INVALID_KINDLE_EMAIL });
  if (typeof email !== "string") throw new HandBackToRails("an email that is not a string");

  const viewer = viewerOf(input);
  if (purchase && (purchase.stripe_refunded === true || (purchase.chargeback_date !== null && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed")) || PurchaseFlags.isSet(purchase.flags, "is_access_revoked"))) return notFound();
  if (purchase?.rental_expired === true) return notFound();
  const testPurchase = isTestPurchase(loaded);
  if (testPurchase && !testPurchaseViewer(loaded, viewer)) return notFound();
  if (purchase && subscription && !grantsAccess(subscription, loaded.product, new Date())) return notFound();
  const viewerOwns = await viewerOwnsSubscription(loaded, viewer);
  if (purchase && viewer.currentUser && purchaser && viewer.loggedInUser?.id !== purchaser.id && !viewerOwns && !isTeamMember(viewer.loggedInUser!)) return notFound();
  if (purchase && UrlRedirectFlags.isSet(redirect.flags, "has_been_seen") && redirect.imported_customer_id === null) {
    const confirmed = readEncryptedCookie(railsCookieSecrets(), CONFIRMED_REDIRECT_COOKIE, input.request.cookies.get(CONFIRMED_REDIRECT_COOKIE) ?? undefined) === redirect.token;
    if (!(confirmed || viewerOwns || (purchaser && purchaser.id === viewer.loggedInUser?.id) || purchase.ip_address === requestIp(input.request))) return notFound();
  }

  const fileId = input.params.file_external_id;
  const delivery = typeof fileId === "string" && fileId !== "" ? findFile(await aliveProductFiles(loaded), fileId) : undefined;
  if (!delivery) return json({ success: false, error: "File not found" }, NOT_FOUND);
  if (!canSendToKindle(delivery.file)) return json({ success: false, error: "This file cannot be sent to Kindle" }, UNPROCESSABLE_ENTITY);
  if (viewer.loggedInUser !== null) throw new HandBackToRails("a signed-in buyer's kindle_email is saved on their user");

  if (!KINDLE_EMAIL.test(email)) return json({ success: false, error: INVALID_KINDLE_EMAIL });
  await deliverLater(currentJobsRuntime(), { mailer: CUSTOMER_MAILER, method: "send_to_kindle", args: [email, Number(delivery.file.id), Number(redirect.id)], queue: "critical" }, mailRoute(CUSTOMER_MAILER, "send_to_kindle"));
  await createConsumptionEvent(loaded, input.request, "read", delivery.file.id, new Date());
  return json({ success: true });
}
