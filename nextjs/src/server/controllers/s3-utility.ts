// S3UtilityController (app/controllers/s3_utility_controller.rb): the endpoints the uploader calls to sign multipart uploads.
import { createHmac } from "node:crypto";

import { Prisma } from "@prisma/client";

import { isConfiguredService, publicStorageUrl } from "../infra/active-storage.ts";
import { cdnUrlFor } from "../infra/cdn-url.ts";
import { storageConfig } from "../infra/storage.ts";
import { selectRows, table, column } from "../models/sql.ts";
import { authorize } from "../policies/authorize.ts";
import { s3UtilityPolicy } from "../policies/s3-utility.ts";
import { NotAuthorizedError } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json, jsonAction, jsonSellerGuard, plain } from "./json-actions.ts";
import type { MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";

// Time#httpdate
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
export function httpdate(time: Date): string {
  return `${DAYS[time.getUTCDay()]}, ${pad(time.getUTCDate())} ${MONTHS[time.getUTCMonth()]} ${time.getUTCFullYear()} ${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())} GMT`;
}

// Utilities.sign_with_aws_secret_key
export function signWithAwsSecretKey(toSign: string, secret: string): string {
  return createHmac("sha1", secret).update(toSign).digest("base64");
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function generateMultipartSignature({ params, context, request }: MutationInput): Promise<ActionResult> {
  const toSign = params.to_sign;
  if (toSign === undefined || toSign === null || toSign === "" || (typeof toSign === "string" && !isPresent(toSign)))
    return json({ success: false, error: "Missing required parameter: to_sign" }, 400);
  if (typeof toSign !== "string") return json({ success: false, error: "Invalid parameter: to_sign" }, 400);

  // Newlines split the body in S3's eyes, so every line that names a path must be under the seller's own prefix.
  const owned = new RegExp(
    `^/${escapeRegExp(storageConfig().s3Bucket)}/\\w+/${escapeRegExp(context.currentSeller!.external_id ?? "")}/`,
    "u",
  );
  for (const url of toSign.split(/[\n\r\s]/u).filter((part) => part.startsWith("/"))) {
    if (!owned.test(url)) return json({ success: false, error: "Unauthorized" }, 403);
  }
  const secret = storageConfig().secretAccessKey;
  if (secret === undefined) throw new HandBackToRails("AWS_SECRET_ACCESS_KEY is not configured");
  // `render inline:` renders the signature through ERB, and answers in the request's format
  const format = requestFormat(request);
  if (format === "other") throw new HandBackToRails("a format that is neither HTML nor JSON");
  return {
    status: 200,
    body: signWithAwsSecretKey(toSign, secret),
    contentType: format === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    paramsRead: true,
  };
}

async function cdnUrlForBlob({ params, request }: MutationInput): Promise<ActionResult> {
  const key = params.key;
  const [row] =
    typeof key === "string"
      ? await selectRows<{ service_name: string }>(
          Prisma.sql`SELECT ${Prisma.raw("`active_storage_blobs`.*")} FROM ${table("active_storage_blobs")} WHERE ${column("active_storage_blobs", "key")} = ${key} LIMIT 1`,
        )
      : [];
  if (!row) throw new RoutingError("Not Found");
  // A blob on another service gets a signed URL only Rails builds.
  if (!isConfiguredService(row.service_name))
    throw new HandBackToRails("a blob outside the configured storage service");
  const url = cdnUrlFor(publicStorageUrl(key as string))!;
  const format = requestFormat(request);
  if (format === "json") return json({ url });
  if (format === "html") return { status: 302, location: url };
  throw new HandBackToRails("a format that is neither HTML nor JSON");
}

const ACTIONS = {
  generate_multipart_signature: generateMultipartSignature,
  current_utc_time_string: async (): Promise<ActionResult> => plain(httpdate(new Date())),
  cdn_url_for_blob: cdnUrlForBlob,
};

// The route handler of one action: Sellers::BaseController's filters, then `authorize :s3_utility`.
export function s3UtilityRoute(action: keyof typeof ACTIONS) {
  return (request: Request) =>
    jsonAction(request, {}, {}, async (input) => {
      const refused = await jsonSellerGuard(input, (context) => authorize(s3UtilityPolicy[action], context));
      return refused ?? ACTIONS[action](input);
    });
}

export { NotAuthorizedError };
