// ProductReviewVideos::{Streams,StreamingUrls,UploadContexts}Controller (app/controllers/product_review_videos/): the buyer review form's
// video player and upload form. Reads only.
//
// Not ported: a request for the stream or the urls in a format Rails answers with a redirect to the dashboard (a refused HTML visit).
import { timingSafeEqual } from "node:crypto";

import type { ProductReviewVideo, VideoFile } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { signedCloudfrontUrl, signedDownloadUrlForS3KeyAndFilename } from "../infra/signed-urls.ts";
import { storageConfig } from "../infra/storage.ts";
import { s3Fields } from "../models/product-file.ts";
import { emailDigest } from "../page-props/buyer/reviews.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { loadSellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { signedOutRefusal } from "./wishlists-mutations.ts";

const SMIL_TYPE = "application/smil+xml";

// Builder::XmlMarkup escapes attribute values
const xmlAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

type Found = {
  video: ProductReviewVideo;
  videoFile: VideoFile | null;
  purchase: { email: string | null; id: bigint; purchaser_id: bigint | null; seller_id: bigint | null };
};

// `ProductReviewVideo.alive.find_by_external_id!`, with what the policy and the digest read.
async function findVideo(externalId: string | undefined): Promise<Found> {
  const id = externalId === undefined ? null : decrypt(externalId);
  const video =
    id === null ? null : await db.productReviewVideo.findFirst({ where: { id: BigInt(id), deleted_at: null } });
  if (video === null) throw new RoutingError("Not Found");
  const review = await db.productReview.findFirst({ where: { id: video.product_review_id } });
  const purchaseId = review?.purchase_id ?? null;
  const purchase = purchaseId === null ? null : await db.purchase.findFirst({ where: { id: purchaseId } });
  if (purchase === null) throw new HandBackToRails("a video whose review or purchase is gone");
  const videoFile = await db.videoFile.findFirst({ where: { record_id: video.id, record_type: "ProductReviewVideo" } });
  return { video, videoFile, purchase };
}

// ActiveSupport::SecurityUtils.secure_compare
function secureCompare(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// `approved? || authorized_by_purchase_email_digest?`
function anonymousAccess({ video, purchase }: Found, digest: unknown): boolean {
  if (video.approval_status === "approved") return true;
  const expected = emailDigest(purchase);
  if (expected === null) throw new HandBackToRails("a purchase without an email, whose digest comparison raises");
  if (digest !== undefined && digest !== null && typeof digest !== "string")
    throw new HandBackToRails("a digest that is not text");
  return secureCompare(expected, digest ?? "");
}

type Access = { allowed: true } | { allowed: false; message: string };

// `authorize @product_review_video, :stream?` (ProductReviewVideoPolicy#stream?): the purchaser or the seller of the current account.
async function streamAccess(input: MutationInput, found: Found): Promise<Access> {
  const context = await loadSellerContext(input.context);
  if (context.user === null || context.seller === null)
    return { allowed: false, message: "You are not allowed to perform this action." };
  const allowed = found.purchase.purchaser_id === context.user.id || found.purchase.seller_id === context.seller.id;
  return allowed ? { allowed } : { allowed: false, message: notAllowedMessage(context) };
}

async function fileOf(found: Found): Promise<{ key: string; filename: string }> {
  if (found.videoFile === null) throw new TypeError("undefined method 'video_file' for nil");
  const owner = await db.user.findFirst({ where: { id: found.videoFile.user_id ?? -1n } });
  const fields = s3Fields(found.videoFile.url, owner?.external_id ?? null);
  // `s3_key` is nil for a url outside S3_BASE_URL, which the signing then raises on.
  if (fields === null) throw new HandBackToRails("a video file whose url is not on S3");
  return { key: fields.key, filename: fields.filename };
}

// GET /product_review_videos/:product_review_video_id/streaming_urls
async function streamingUrls(input: MutationInput): Promise<ActionResult> {
  const found = await findVideo(input.routeParams.id);
  const digest = input.params.purchase_email_digest;
  if (!anonymousAccess(found, digest)) {
    const access = await streamAccess(input, found);
    if (!access.allowed) {
      if (requestFormat(input.request) !== "json")
        throw new HandBackToRails("a refused streaming_urls request that is not JSON");
      return { ...jsonResponse({ success: false, error: access.message }, 401), rescued: true };
    }
  }
  const { key, filename } = await fileOf(found);
  const externalId = encrypt(found.video.id);
  const query =
    digest === undefined || digest === null ? "" : `?purchase_email_digest=${encodeURIComponent(String(digest))}`;
  return jsonResponse({
    streaming_urls: [
      `/product_review_videos/${externalId}/stream.smil${query}`,
      await signedDownloadUrlForS3KeyAndFilename(key, filename, { isVideo: true }),
    ],
  });
}

// GET /product_review_videos/:product_review_video_id/stream.smil
async function stream(input: MutationInput): Promise<ActionResult> {
  const found = await findVideo(input.routeParams.id);
  if (!anonymousAccess(found, input.params.purchase_email_digest)) {
    const access = await streamAccess(input, found);
    // `head :unauthorized`: the SMIL denial is rescued in the action, so the after_actions run.
    if (!access.allowed)
      return {
        status: 401,
        body: "",
        contentType: SMIL_TYPE,
        headers: { "Cache-Control": "no-cache" },
        paramsRead: true,
      };
  }
  const { key } = await fileOf(found);
  const body = `<smil><body><switch><video src="${xmlAttribute(signedCloudfrontUrl(key, { isVideo: true }))}"/></switch></body></smil>`;
  return { status: 200, body, contentType: `${SMIL_TYPE}; charset=utf-8`, paramsRead: true };
}

// GET /product_review_videos/upload_context
function uploadContext(input: MutationInput): ActionResult {
  const refusal = signedOutRefusal(input);
  if (refusal) return refusal;
  const user = railsLoggedInUser(input.context)!;
  const config = storageConfig();
  return jsonResponse({
    aws_access_key_id: config.accessKeyId,
    s3_url: `${config.s3Endpoint}/${config.s3Bucket}`,
    user_id: user.external_id,
  });
}

registerMutations(
  {
    method: "GET",
    pattern: "/product_review_videos/upload_context",
    skipForgeryProtection: true,
    run: async (input) => uploadContext(input),
  },
  {
    method: "GET",
    pattern: "/product_review_videos/:id/streaming_urls",
    skipForgeryProtection: true,
    run: streamingUrls,
  },
  { method: "GET", pattern: "/product_review_videos/:id/stream.smil", skipForgeryProtection: true, run: stream },
);
