// Api::Internal::* (app/controllers/api/internal): the JSON endpoints the dashboard's React pages and the mobile app call.
// The API-host ones (minimum mobile version, home page numbers, the GRMC webhook) have no session; the rest are
// ApplicationController actions behind `authenticate_user!`, whose refusals are `e404_json` and Pundit's 401 JSON.
import { createHmac, timingSafeEqual } from "node:crypto";

import { Prisma, type Installment } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { doorkeeperAuthorize, doorkeeperToken } from "../auth/api-token.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { RubySymbol, type MarshalValue } from "../cache/marshal.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { getConfig } from "../infra/config.ts";
import { getRedis } from "../infra/redis.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";
import { urlClickCounts } from "../models/email-engagement-store.ts";
import { audienceMembersFilterParams } from "../models/installment-audience.ts";
import { InstallmentPost } from "../models/installment-post.ts";
import { createBlast, RECIPIENT_FILTER_UNOPENED } from "../models/post-email-blast.ts";
import { autoResumeEligible, deliveryStatus, redisInt, type Blast } from "../page-props/emails/installment-props.ts";
import { findAliveVideo, setApprovalStatusBang } from "../models/product-review-video.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { PAGE_URL_HEADER } from "../page-props/render-state.ts";
import { authorize } from "../policies/authorize.ts";
import { installmentPolicy } from "../policies/installment.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import { productReviewVideoPolicy } from "../policies/product-review-video.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { filterCount } from "../search/audience-member-search.ts";
import type { JsonValue } from "../search/es-json.ts";

import {
  forwardToRails,
  HandBackToRails,
  processAction,
  RoutingError,
  type ActionResult,
  type Rendered,
} from "./application-controller.ts";
import { agentActionStatus, agentConversationsLatest, agentTurnStatus } from "./internal-agent.ts";
import { agentCustomHtmlPreview } from "./internal-agent-previews.ts";
import { productPosts } from "./internal-product-posts.ts";
import { json, jsonAction } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { numberWithDelimiter } from "./number-with-delimiter.ts";
import { assertFlatQuery } from "./rails-params.ts";
import { railsRequest, type RailsRequest } from "./rails-request.ts";
import { authorizeJson, notFoundJson } from "./seller-json.ts";

const UNAUTHORIZED = 401;
const UNPROCESSABLE_ENTITY = 422;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;

// A port that cannot prove an answer hands the request back whole; these actions only read before they answer.
async function handingBack<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotPortedError || error instanceof PageNotPortedError)
      throw new HandBackToRails(error.message);
    throw error;
  }
}

// ---- API host, no session

// `head :status`, which names no format of its own.
const head = (status: number, headers: Record<string, string> = {}): Rendered => ({
  status,
  body: "",
  contentType: "text/html",
  headers,
  paramsRead: true,
});

// The same from a before_action: the after_actions did not run.
const halted = (status: number, headers: Record<string, string> = {}): ActionResult => ({
  ...head(status, headers),
  rescued: true,
});

// `$redis.get(key)` for a value the app tolerates losing: a transport error reads as nil.
async function redisGetOrNil(key: string): Promise<string | null> {
  try {
    return await getRedis("main").get(key);
  } catch {
    return null;
  }
}

// Api::Internal::MobileMinimumVersionsController#show
export async function mobileMinimumVersion(request: RailsRequest): Promise<ActionResult> {
  assertFlatQuery(request.queryString);
  const parameters = Object.fromEntries(new URLSearchParams(request.queryString));
  const token = await doorkeeperToken({
    authorization: request.headers.get("authorization"),
    parameters,
    path: request.path,
  });
  const authorization = await doorkeeperAuthorize(token, ["account", "mobile_api"]);
  if (!authorization.ok) return halted(authorization.status, authorization.headers);
  return json({
    minimum_version: await redisGetOrNil("mobile:minimum_version"),
    minimum_update_created_at: await redisGetOrNil("mobile:minimum_update_created_at"),
  });
}

const HOME_PAGE_SOURCE = "home_page_numbers_controller.rb";
const HOME_PAGE_NUMBERS_KEY = "homepage_numbers";
const HOME_PAGE_NUMBERS_TTL_SECONDS = 24 * 60 * 60;

// A hash read from Rails.cache with symbol keys, as the JSON the controller renders.
function cachedHash(value: MarshalValue): JsonValue | undefined {
  if (!(value instanceof Map) || value.size === 0) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of value) {
    if (!(key instanceof RubySymbol) || typeof entry !== "string")
      throw new NotPortedError("a cached home page figure that is not a string", HOME_PAGE_SOURCE);
    out[key.name] = entry;
  }
  return out;
}

// Api::Internal::HomePageNumbersController#index
export const homePageNumbers = (): Promise<ActionResult> => handingBack(homePageNumbersUnchecked);

async function homePageNumbersUnchecked(): Promise<ActionResult> {
  const cache = railsCache();
  const cached = await cache.read(HOME_PAGE_NUMBERS_KEY);
  const present = cached === undefined || cached === null ? undefined : cachedHash(cached);
  if (present !== undefined) return json(present);

  let stalled = false;
  let payout: string | null = null;
  try {
    payout = await getRedis("main").get("homepage:prev_week_payout_usd");
  } catch {
    stalled = true;
  }
  const figure = `$${numberWithDelimiter(payout)}`;
  // A stalled read is served uncached: degrading the figure must not publish it on the homepage for a day.
  if (!stalled)
    await cache.write(HOME_PAGE_NUMBERS_KEY, new Map([[new RubySymbol("prev_week_payout_usd"), figure]]), {
      expiresIn: HOME_PAGE_NUMBERS_TTL_SECONDS,
    });
  return json({ prev_week_payout_usd: figure });
}

const GRMC_SIGNATURE_TOLERANCE_MS = 60_000;
const MILLISECONDS_PER_SECOND = 1000;

// `request.headers["HTTP_GRMC_SIGNATURE"].to_s.scan(/([^,=]+)=([^,=]+)/).to_h.slice("t", "v0").values`: a header with only v0 reads
// that value as the timestamp, as in Ruby.
function signatureParts(header: string): { timestamp: string | undefined; signature: string | undefined } {
  const pairs = new Map<string, string>();
  for (const match of header.matchAll(/([^,=]+)=([^,=]+)/gu)) pairs.set(match[1]!, match[2]!);
  const [timestamp, signature] = ["t", "v0"].filter((key) => pairs.has(key)).map((key) => pairs.get(key)!);
  return { timestamp, signature };
}

// A JSON value whose Ruby parse Node writes back byte for byte: integers within 2^53 and no floats, so `perform_async` serializes
// the same arguments.
function plainJson(text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, ((_key: string, value: unknown, context: { source?: string }) => {
      if (typeof value === "number" && !/^-?(0|[1-9]\d*)$/u.test(context.source ?? ""))
        throw new HandBackToRails("a webhook number that is not an integer");
      if (typeof value === "number" && !Number.isSafeInteger(value))
        throw new HandBackToRails("a webhook integer beyond 2^53");
      return value;
    }) as Parameters<typeof JSON.parse>[1]);
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    throw new HandBackToRails("a webhook body that is not JSON");
  }
  return parsed as JsonValue;
}

function grmcWebhook(input: MutationInput): Promise<ActionResult> {
  // The handler reads the body a second time: Rails hands that read the raw post only once the JSON params parser has run.
  if (!/^application\/json\b/iu.test(input.request.headers.get("content-type") ?? ""))
    throw new HandBackToRails("a GRMC webhook that is not application/json");
  const body = Buffer.from(input.rawBody);
  const { timestamp, signature } = signatureParts(input.request.headers.get("grmc-signature") ?? "");
  const secret = getConfig("GRMC_WEBHOOK_SECRET");
  if (secret === undefined) throw new HandBackToRails("a GRMC webhook without a secret");
  const withinTolerance =
    Math.abs(rubyToI(timestamp) / MILLISECONDS_PER_SECOND - Date.now() / MILLISECONDS_PER_SECOND) <=
    GRMC_SIGNATURE_TOLERANCE_MS / MILLISECONDS_PER_SECOND;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature ?? "");
  if (!withinTolerance || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Promise.resolve({
      ...json({ success: false, message: "invalid timestamp or signature" }, UNAUTHORIZED),
      rescued: true,
    });
  }
  return handleGrmc(body);
}

async function handleGrmc(body: Buffer): Promise<ActionResult> {
  const notification = plainJson(body.toString("utf8"));
  await performAsync("HandleGrmcCallbackJob", [notification]);
  return head(200);
}

// ---- Dashboard JSON endpoints

// Api::Internal::BaseController < ApplicationController: `authenticate_user!` answers e404_json to a JSON request.
function requireSignedIn(input: MutationInput): ActionResult | null {
  if (railsLoggedInUser(input.context) === null) return { ...notFoundJson(), rescued: true };
  if (input.context.currentSeller === null) throw new HandBackToRails("a signed-in request without a current seller");
  return null;
}

// `current_seller.installments.alive.find_by_external_id(external_id)`
async function findSellerInstallment(sellerId: bigint | number, externalId: string): Promise<Installment | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${sellerId} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  return row ? castRow<Installment>("Installment", row) : null;
}

type InstallmentAction = (input: MutationInput, installment: InstallmentPost) => Promise<ActionResult>;

// `installment = ...find_by_external_id(params[:id])`, then `return (skip_authorization and e404_json) unless installment`,
// then the policy's query.
async function withSellerInstallment(
  input: MutationInput,
  query: (context: Parameters<typeof installmentPolicy.index>[0]) => boolean,
  run: InstallmentAction,
): Promise<ActionResult> {
  const refused = requireSignedIn(input);
  if (refused) return refused;
  const installment = await findSellerInstallment(input.context.currentSeller!.id, input.routeParams.id!);
  if (installment === null) return notFoundJson();
  const denied = await authorizeJson(input, (context) => authorize(query, context));
  if (denied) return denied;
  return run(input, new InstallmentPost(installment));
}

// Api::Internal::Installments::AudienceCountsController#show
export const installmentAudienceCount = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(() =>
      withSellerInstallment(input, installmentPolicy.updatedAudienceCount, async (_input, post) => {
        // Installment#audience_members_count
        const count = await filterCount(post.row.seller_id, await audienceMembersFilterParams(post));
        return json({ count });
      }),
    ),
  );

const VIEW_ATTACHMENTS_URL = "view_attachments_url";

// Api::Internal::Installments::ClickedUrlsController#show
export const installmentClickedUrls = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(() =>
      withSellerInstallment(input, installmentPolicy.index, async (_input, post) => {
        const counts = [...(await urlClickCounts(post.id))];
        // `sort_by { |_, v| -v }` is not stable: only a strict order is one Ruby would repeat.
        if (new Set(counts.map(([, count]) => count)).size !== counts.length)
          throw new NotPortedError("clicked URLs with equal counts", "installment.rb");
        counts.sort((a, b) => b[1] - a[1]);
        return json({
          clicked_urls: counts.map(([url, count]) => ({
            url: url === VIEW_ATTACHMENTS_URL ? "View content" : url,
            count,
          })),
        });
      }),
    ),
  );

const RECIPIENT_COUNT_SCALARS = [
  "paid_more_than_cents",
  "paid_less_than_cents",
  "bought_from",
  "active_customers_only",
  "minimum_license_uses",
  "installment_type",
  "created_after",
  "created_before",
  "not_clicked_post_id",
] as const;
const RECIPIENT_COUNT_LISTS = [
  "bought_products",
  "bought_variants",
  "not_bought_products",
  "not_bought_variants",
  "affiliate_products",
  "waitlisted_products",
] as const;

const isScalar = (value: unknown): value is string | null => value === null || typeof value === "string";

// A cents filter stays the string the query carried; the filter reads it as the integer it spells.
function centsValue(name: string, value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  if (!/^\d{1,15}$/u.test(value)) throw new NotPortedError(`${name} that is not plain digits`, "installment.rb");
  return Number(value);
}

// Api::Internal::Installments::RecipientCountsController#show: `params.permit(...)` into an unsaved Installment of the seller.
export const installmentRecipientCount = (request: Request) =>
  jsonAction(request, {}, {}, (input) =>
    handingBack(async () => {
      const refused = requireSignedIn(input);
      if (refused) return refused;
      const denied = await authorizeJson(input, (context) =>
        authorize(installmentPolicy.updatedRecipientCount, context),
      );
      if (denied) return denied;

      const seller = input.context.currentSeller!;
      const permitted: Record<string, unknown> = {};
      for (const name of RECIPIENT_COUNT_SCALARS) {
        const value = input.params[name];
        if (value === undefined) continue;
        if (isScalar(value)) permitted[name] = value;
        else if (typeof value !== "object") throw new HandBackToRails("a filter parameter that is not text");
      }
      for (const name of RECIPIENT_COUNT_LISTS) {
        const value = input.params[name];
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) permitted[name] = value;
      }

      const jsonData: Record<string, unknown> = { ...permitted };
      delete jsonData.installment_type;
      for (const name of ["paid_more_than_cents", "paid_less_than_cents"] as const)
        if (name in jsonData) jsonData[name] = centsValue(name, jsonData[name] as string | null);
      const post = new InstallmentPost({
        seller_id: seller.id,
        installment_type: (permitted.installment_type as string | null | undefined) ?? null,
        json_data: JSON.stringify(jsonData),
      } as unknown as Installment);

      const audience = await filterCount(seller.id);
      const recipients = await filterCount(seller.id, await audienceMembersFilterParams(post));
      return json({ audience_count: audience, recipient_count: recipients });
    }),
  );

// FetchProductByUniquePermalink: `params[:id] || params[:link_id] || params[:product_id]`, a blank one is a 404.
async function fetchProductByUniquePermalink(input: MutationInput): Promise<{ id: bigint; user_id: bigint | null }> {
  const given = input.params.id ?? input.params.link_id ?? input.routeParams.product_id;
  if (given !== undefined && given !== null && typeof given !== "string")
    throw new HandBackToRails("a product permalink that is not text");
  if (given === undefined || given === null || given.trim() === "") throw new RoutingError("Not Found");
  const [row] = await selectRows<{ id: bigint; user_id: bigint | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${given} LIMIT 1`,
  );
  if (!row) throw new RoutingError("Not Found");
  return row;
}

// Api::Internal::ExistingProductFilesController#index. The serialization of a ProductFile (thumbnails, subtitles, signed URLs) is
// Rails': only a seller whose library holds no live file is answered here.
export const existingProductFiles = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(async () => {
      const refused = requireSignedIn(input);
      if (refused) return refused;
      const product = await fetchProductByUniquePermalink(input);
      // `product_accessible_by_current_user?`: the owner, else 404 unless the logged-in user collaborates on the product. A collaborator's
      // list stops at the product's own files (`collaborator_editing?`), a subset of the owner's library, so an empty library is empty for both.
      if (product.user_id === null || BigInt(product.user_id) !== BigInt(input.context.currentSeller!.id)) {
        const collaborating = await collaboratingProductIds(await loadSellerContext(input.context), [product.id]);
        if (!collaborating.has(BigInt(product.id))) throw new RoutingError("Not Found");
      }
      const [file] = await selectRows(
        Prisma.sql`SELECT 1 AS present FROM ${table("product_files")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_files", "link_id")} WHERE ${column("links", "user_id")} = ${product.user_id} AND ${column("product_files", "deleted_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL LIMIT 1`,
      );
      if (file) throw new NotPortedError("ProductFile#as_json(existing_product_file: true)", "product_file.rb");
      return json({ existing_files: [] });
    }),
  );

// ---- Non-opener resends

const RESEND_THROTTLE_MS = 24 * 60 * 60 * 1000;
const MAX_RESENDS = 3;
const IN_FLIGHT_GRACE_MS = 60 * 60 * 1000;
const NON_OPENER_BLASTS = Prisma.sql`${column("post_email_blasts", "recipient_filter")} = ${RECIPIENT_FILTER_UNOPENED}`;

async function blastCount(extra: Prisma.Sql, postId: bigint | number): Promise<number> {
  const [row] = await selectRows<{ total: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS total FROM ${table("post_email_blasts")} WHERE ${column("post_email_blasts", "post_id")} = ${postId} AND ${NON_OPENER_BLASTS} AND ${extra}`,
  );
  return Number(row?.total ?? 0);
}

// `recently_resent?`
async function recentlyResent(postId: bigint | number, now: Date): Promise<boolean> {
  const inFlight = Prisma.sql`${column("post_email_blasts", "completed_at")} IS NULL AND ${column("post_email_blasts", "requested_at")} >= ${new Date(now.getTime() - IN_FLIGHT_GRACE_MS)}`;
  const delivered = Prisma.sql`${column("post_email_blasts", "completed_at")} >= ${new Date(now.getTime() - RESEND_THROTTLE_MS)} AND ${column("post_email_blasts", "delivery_count")} >= 1`;
  return (await blastCount(inFlight, postId)) > 0 || (await blastCount(delivered, postId)) > 0;
}

// `resend_limit_reached?`
async function resendLimitReached(postId: bigint | number): Promise<boolean> {
  return (
    (await blastCount(
      Prisma.sql`${column("post_email_blasts", "completed_at")} IS NOT NULL AND ${column("post_email_blasts", "delivery_count")} >= 1`,
      postId,
    )) >= MAX_RESENDS
  );
}

// `resendable_to_non_openers?`: published, emailed, sent to customers, and not a send that expired without reaching anyone.
async function resendableToNonOpeners(post: InstallmentPost): Promise<boolean> {
  if (post.row.published_at === null || !post.flag("send_emails") || !post.sellerOrProductOrVariantType) return false;
  const regular = Prisma.sql`(${column("post_email_blasts", "recipient_filter")} IS NULL OR ${column("post_email_blasts", "recipient_filter")} != ${RECIPIENT_FILTER_UNOPENED})`;
  const [row] = await selectRows<{ expired: bigint | number; reached: bigint | number }>(
    Prisma.sql`SELECT COALESCE(SUM(${column("post_email_blasts", "expired_at")} IS NOT NULL), 0) AS expired, COALESCE(SUM(${column("post_email_blasts", "completed_at")} IS NOT NULL OR ${column("post_email_blasts", "first_email_delivered_at")} IS NOT NULL), 0) AS reached FROM ${table("post_email_blasts")} WHERE ${column("post_email_blasts", "post_id")} = ${post.id} AND ${regular}`,
  );
  return !(Number(row?.expired ?? 0) > 0 && Number(row?.reached ?? 0) === 0);
}

// `before_action :set_installment` (an unresolvable post is a 404 that halts the chain) and `authorize @installment, :resend_to_non_openers?`.
async function resendableInstallment(
  input: MutationInput,
): Promise<{ post: InstallmentPost } | { halt: ActionResult }> {
  const refused = requireSignedIn(input);
  if (refused) return { halt: refused };
  const row = await findSellerInstallment(input.context.currentSeller!.id, input.routeParams.id!);
  const post = row === null ? null : new InstallmentPost(row);
  if (post === null || !(await resendableToNonOpeners(post))) return { halt: { ...notFoundJson(), rescued: true } };
  const denied = await authorizeJson(input, (context) => authorize(installmentPolicy.resendToNonOpeners, context));
  return denied ? { halt: denied } : { post };
}

// Api::Internal::Installments::NonOpenerResendsController#show counts the recipients under a time budget of a few hundred milliseconds
// from the audience tables: Node answers its gates and Rails the count.
export const nonOpenerResendPreview = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(async () => {
      const resolved = await resendableInstallment(input);
      if ("halt" in resolved) return resolved.halt;
      throw new HandBackToRails("the recipient count of a non-opener resend");
    }),
  );

// Api::Internal::Installments::NonOpenerResendsController#create.
async function nonOpenerResend(input: MutationInput): Promise<ActionResult> {
  return handingBack(async () => {
    const resolved = await resendableInstallment(input);
    if ("halt" in resolved) return resolved.halt;
    const { post } = resolved;

    const unprocessable = (error: string): { halt: ActionResult } => ({
      halt: json({ success: false, error }, UNPROCESSABLE_ENTITY),
    });
    const created = await transaction(async () => {
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "id")} = ${post.id} LIMIT 1 FOR UPDATE`,
      );
      if (await resendLimitReached(post.id))
        return unprocessable(`You can resend to non-openers up to ${MAX_RESENDS} times per email.`);
      if (await recentlyResent(post.id, new Date()))
        return unprocessable("You can only resend to non-openers once every 24 hours.");
      return {
        blast: await createBlast(post, { requested_at: new Date(), recipient_filter: RECIPIENT_FILTER_UNOPENED }),
      };
    });
    if ("halt" in created) return created.halt;
    // Who receives it is worked out by the job: for a large audience that takes minutes.
    await performAsync("SendPostBlastEmailsJob", [Number(created.blast.get("id"))]);
    return json({ success: true });
  });
}

// ---- Product review videos

type VideoAction = "approve" | "reject";

// Api::Internal::ProductReviewVideos::{Approvals,Rejections}Controller#create
async function reviewVideoDecision(input: MutationInput, action: VideoAction): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null) return { ...notFoundJson(), rescued: true };
  const id = decrypt(input.routeParams.product_review_video_id!);
  if (id === null) throw new RoutingError("Not Found");
  // `find_by_external_id!` raises RecordNotFound, a 404 page for a JSON request too.
  const video = await findAliveVideo(BigInt(id));
  if (video === null) throw new RoutingError("Not Found");
  // `video.product_review.purchase.seller_id`: a review without a purchase is a NoMethodError in Rails.
  const [owner] = await selectRows<{ seller_id: bigint | null; purchase_id: bigint | null }>(
    Prisma.sql`SELECT ${column("purchases", "seller_id")}, ${column("product_reviews", "purchase_id")} FROM ${table("product_reviews")} LEFT JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("product_reviews", "purchase_id")} WHERE ${column("product_reviews", "id")} = ${video.get("product_review_id")} LIMIT 1`,
  );
  if (owner === undefined || owner.purchase_id === null)
    throw new NotPortedError("ProductReviewVideoPolicy", "a video whose review has no purchase");
  const sellerId = owner.seller_id;
  const denied = await authorizeJson(input, (context) =>
    authorize(productReviewVideoPolicy[action], context, sellerId),
  );
  if (denied) return denied;
  await setApprovalStatusBang(video, action === "approve" ? "approved" : "rejected");
  // The route defaults the format to JSON, which `head` takes as its content type.
  return { ...head(200), contentType: "application/json" };
}

// ---- Previews and sends that mail, write a blast or attach a blob: Node answers the gates, Rails the rest

// Api::Internal::Installments::PreviewEmailsController#create mails the preview to the signed-in user.
const previewEmail = (input: MutationInput) =>
  handingBack(() =>
    withSellerInstallment(input, installmentPolicy.preview, () => {
      throw new HandBackToRails("a preview email");
    }),
  );

const NOT_WAITING_ON_RECIPIENTS = "This email is not waiting on any recipients.";
const RETRYING_AUTOMATICALLY = "We are retrying this automatically.";
const SEND_STARTED_RECENTLY = "A send was started recently. Check back in a few hours.";
const ALREADY_SENDING = "This email is already sending.";
const ENDED_UNSENT = ["expired", "abandoned"];

const BLAST_COLUMNS = [
  "id",
  "requested_at",
  "first_email_delivered_at",
  "last_email_delivered_at",
  "delivery_count",
  "completed_at",
  "recipient_filter",
  "expired_at",
  "expiry_reason",
] as const;

// `latest_regular_blast`: `blasts.reject(&:to_non_openers?).max_by(&:requested_at)`; the first of equal times wins.
async function latestRegularBlast(postId: bigint | number): Promise<Blast | null> {
  const rows = await selectRows<Blast>(
    Prisma.sql`SELECT ${Prisma.join(BLAST_COLUMNS.map((name) => column("post_email_blasts", name)))} FROM ${table("post_email_blasts")} WHERE ${column("post_email_blasts", "post_id")} = ${postId} ORDER BY ${column("post_email_blasts", "id")} ASC`,
  );
  const regular = rows.filter((blast) => blast.recipient_filter !== RECIPIENT_FILTER_UNOPENED);
  // `max_by` compares nil with a Time and raises.
  if (regular.length > 1 && regular.some((blast) => blast.requested_at === null))
    throw new HandBackToRails("a blast with no requested_at beside others");
  return regular.reduce<Blast | null>(
    (latest, blast) => (latest === null || (blast.requested_at?.getTime() ?? 0) > (latest.requested_at?.getTime() ?? 0) ? blast : latest),
    null,
  );
}

const blastStatus = async (blast: Blast) =>
  deliveryStatus(blast, await redisInt(`blast:${blast.id}:pending_recipients`), Date.now());

// `render json: { success: false, error: }, status: :unprocessable_entity`
const unprocessable = (error: string) => json({ success: false, error }, UNPROCESSABLE_ENTITY);

// Api::Internal::Installments::RemainingSendsController#send_again: a send that ended before reaching anyone gets a new blast.
async function sendAgain(row: Installment): Promise<ActionResult> {
  const blastId = await transaction(async () => {
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "id")} = ${row.id} LIMIT 1 FOR UPDATE`,
    );
    const latest = await latestRegularBlast(row.id);
    if (latest === null || !ENDED_UNSENT.includes(await blastStatus(latest))) return null;
    const created = await createBlast(new InstallmentPost(row), { requested_at: new Date() });
    return Number(created.get("id"));
  });
  if (blastId === null) return unprocessable(ALREADY_SENDING);
  await performAsync("SendPostBlastEmailsJob", [blastId]);
  return json({ success: true });
}

// Api::Internal::Installments::RemainingSendsController#create. What it decides from the blast and Redis is answered here; claiming the
// resume marker and scanning Sidekiq for a live sender go to Rails, before Node has written anything.
async function remainingSend(input: MutationInput): Promise<ActionResult> {
  return handingBack(async () => {
    const refused = requireSignedIn(input);
    if (refused) return refused;
    const row = await findSellerInstallment(input.context.currentSeller!.id, input.routeParams.id!);
    // set_installment: `alive.published.not_workflow_installment`
    if (row === null || row.published_at === null || row.workflow_id !== null)
      return { ...notFoundJson(), rescued: true };
    const denied = await authorizeJson(input, (context) => authorize(installmentPolicy.sendToRemaining, context));
    if (denied) return denied;
    const blast = await latestRegularBlast(row.id);
    if (blast === null) return unprocessable(NOT_WAITING_ON_RECIPIENTS);
    const remaining = await redisInt(`blast:${blast.id}:pending_recipients`);
    const now = Date.now();
    const status = await deliveryStatus(blast, remaining, now);
    if (ENDED_UNSENT.includes(status)) return sendAgain(row);
    if (status !== "incomplete") return unprocessable(NOT_WAITING_ON_RECIPIENTS);
    if (await autoResumeEligible(blast, remaining, now)) return unprocessable(RETRYING_AUTOMATICALLY);
    // `$redis.set(marker, claim, nx: true)` fails while the marker is held; claiming it here would leave Rails' own attempt to fail.
    if ((await getRedis("main").exists(`blast:${blast.id}:auto_resumed`)) > 0) return unprocessable(SEND_STARTED_RECENTLY);
    throw new HandBackToRails("a send to the remaining recipients");
  });
}

// Api::Internal::Customers::SingleCustomerEmailsController#create. `authorize Installment, :create?` runs before the lookup answers
// (a RecordNotFound is rescued into the same authorization), and the email itself is built, sent and cached under a Redis lock.
async function singleCustomerEmail(input: MutationInput): Promise<ActionResult> {
  return handingBack(async () => {
    const refused = requireSignedIn(input);
    if (refused) return refused;
    const denied = await authorizeJson(input, (context) => authorize(installmentPolicy.create, context));
    if (denied) return denied;
    // `current_seller.sales.find_by_external_id!`
    const id = decrypt(input.routeParams.purchase_id!);
    const found =
      id !== null &&
      (
        await selectRows(
          Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${input.context.currentSeller!.id} LIMIT 1`,
        )
      ).length > 0;
    if (!found) return json({ success: false, message: "Customer not found." }, NOT_FOUND);
    throw new HandBackToRails("an email to one customer");
  });
}

// Api::Internal::ReceiptPreviewsController#show renders the receipt template and inlines its CSS.
export const receiptPreview = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(async () => {
      const refused = requireSignedIn(input);
      if (refused) return refused;
      const product = await fetchProductByUniquePermalink(input);
      if (product.user_id === null || BigInt(product.user_id) !== BigInt(input.context.currentSeller!.id))
        throw new RoutingError("Not Found");
      throw new HandBackToRails("the receipt of a product");
    }),
  );

// Api::Internal::ProductPublicFilesController#create attaches a blob found by its signed id, which only Rails can verify.
async function productPublicFile(input: MutationInput): Promise<ActionResult> {
  return handingBack(async () => {
    const refused = requireSignedIn(input);
    if (refused) return refused;
    // fetch_product_and_enforce_ownership: `Link.find_by_external_id(params[:product_id])`, then `e404` unless it is the seller's
    const given = input.params.product_id;
    if (given !== undefined && given !== null && typeof given !== "string")
      throw new HandBackToRails("a product_id that is not text");
    const id = typeof given === "string" ? decrypt(given) : null;
    const [product] =
      id === null
        ? []
        : await selectRows<{ user_id: bigint | null }>(
            Prisma.sql`SELECT ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${BigInt(id)} LIMIT 1`,
          );
    if (
      product === undefined ||
      product.user_id === null ||
      BigInt(product.user_id) !== BigInt(input.context.currentSeller!.id)
    )
      throw new RoutingError("Not Found");
    const denied = await authorizeJson(input, (context) => authorize(linkPolicy.create, context));
    if (denied) return denied;
    if (typeof input.params.signed_blob_id !== "string")
      return json({ success: false, error: "Invalid signed_blob_id." }, BAD_REQUEST);
    throw new HandBackToRails("a public file attached from a signed blob");
  });
}

registerMutations(
  { method: "POST", pattern: "/internal/grmc/webhook", skipForgeryProtection: true, run: grmcWebhook },
  { method: "POST", pattern: "/internal/installments/:id/non_opener_resend", formats: ["any"], run: nonOpenerResend },
  { method: "POST", pattern: "/internal/installments/:id/preview_email", formats: ["any"], run: previewEmail },
  { method: "POST", pattern: "/internal/installments/:id/remaining_send", formats: ["any"], run: remainingSend },
  {
    method: "POST",
    pattern: "/internal/customers/:purchase_id/single_customer_email",
    formats: ["any"],
    run: singleCustomerEmail,
  },
  { method: "POST", pattern: "/internal/product_public_files", formats: ["any"], run: productPublicFile },
  {
    method: "POST",
    pattern: "/internal/product_review_videos/:product_review_video_id/approvals",
    formats: ["any"],
    run: (input) => reviewVideoDecision(input, "approve"),
  },
  {
    method: "POST",
    pattern: "/internal/product_review_videos/:product_review_video_id/rejections",
    formats: ["any"],
    run: (input) => reviewVideoDecision(input, "reject"),
  },
);

// ---- Dispatcher for the GETs: routes.json marks them `handler: "internal"`, the proxy rewrites them to /gr-public/internal
// (app/gr-public/[action]/route.ts, as for the mobile and v2 APIs), and the route is picked here by path. The POSTs are mutations.

type GetRoute = { pattern: string; run(request: Request, routeParams: Record<string, string>): Promise<Response> };

const apiHost = (action: (request: RailsRequest) => Promise<ActionResult>) => (request: Request) =>
  processAction(request, {}, () => action(railsRequest(request)));

const GET_ROUTES: GetRoute[] = [
  { pattern: "/internal/mobile_minimum_version", run: apiHost(mobileMinimumVersion) },
  { pattern: "/internal/home_page_numbers", run: apiHost(() => homePageNumbers()) },
  { pattern: "/internal/installments/recipient_count", run: (request) => installmentRecipientCount(request) },
  { pattern: "/internal/installments/:id/audience_count", run: installmentAudienceCount },
  { pattern: "/internal/installments/:id/clicked_urls", run: installmentClickedUrls },
  { pattern: "/internal/installments/:id/non_opener_resend", run: nonOpenerResendPreview },
  { pattern: "/internal/products/:product_id/receipt_preview", run: receiptPreview },
  { pattern: "/internal/products/:product_id/existing_product_files", run: existingProductFiles },
  { pattern: "/internal/products/:product_id/product_posts", run: productPosts },
  { pattern: "/internal/agent/conversations/latest", run: (request) => agentConversationsLatest(request) },
  { pattern: "/internal/agent/actions/status", run: (request) => agentActionStatus(request) },
  { pattern: "/internal/agent/turns/:client_turn_id", run: agentTurnStatus },
  { pattern: "/internal/agent/custom_html_previews/:token", run: agentCustomHtmlPreview },
];

function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/.?]+)";
    })
    .join("/");
  const match = new RegExp(`^${source}$`, "u").exec(path);
  return match === null
    ? null
    : Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
}

export async function internalResponse(incoming: Request): Promise<Response> {
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const url = new URL(target, `${protocol}://${host}`);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers });
  for (const route of GET_ROUTES) {
    const routeParams = matchRoute(route.pattern, url.pathname);
    if (routeParams !== null) return route.run(request, routeParams);
  }
  return forwardToRails(request);
}
