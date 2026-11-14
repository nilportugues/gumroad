// InstagramCallbacksController and TiktokCallbacksController: Meta's and TikTok's deauthorize and data-deletion webhooks. Both skip
// forgery protection, so the POSTs are mutations that skip the CSRF and format checks; the status page is a plain GET.
import { Prisma } from "@prisma/client";

import { execute, column, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";
import { defaultUrlOptions } from "../page-props/load-page.ts";
import { esJson } from "../search/es-json.ts";
import { InstagramSignedRequest, isBlank } from "../services/instagram-signed-request.ts";
import { TiktokWebhook } from "../services/tiktok-webhook.ts";

import { HandBackToRails, type ActionOptions, type ActionResult, type Rendered } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const OK = 200;
const JSON_TYPE = "application/json; charset=utf-8";

// `head :status` names no content type of its own.
const head = (status: number): Rendered => ({ status, body: "", contentType: "text/html", paramsRead: true });

// SocialConnectVerification.current.where(platform:, uid:).update_all(superseded_at: Time.current)
async function supersedeVerifications(platform: string, uid: string): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table("social_connect_verifications")} SET ${column("social_connect_verifications", "superseded_at")} = ${new Date()} WHERE ${column("social_connect_verifications", "superseded_at")} IS NULL AND ${column("social_connect_verifications", "platform")} = ${platform} AND ${column("social_connect_verifications", "uid")} = ${uid}`,
  );
}

async function deleteWhere(tableName: string, columnName: string, value: string): Promise<void> {
  await execute(Prisma.sql`DELETE FROM ${table(tableName)} WHERE ${column(tableName, columnName)} = ${value}`);
}

// `params[:signed_request]`: an array or hash raises NoMethodError on #split in Rails.
function signedRequestParam(input: MutationInput): string | null {
  const value = input.params.signed_request;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HandBackToRails("a signed_request that is not a string");
  return value;
}

function signedRequestUserId(input: MutationInput, signedRequest: InstagramSignedRequest): string | null {
  const userId = signedRequest.parse(signedRequestParam(input))?.user_id ?? null;
  return isBlank(userId) ? null : userId;
}

const OPTIONS: ActionOptions = {};

// The URL helper writes the request's own host: ApplicationController#default_url_options.
function dataDeletionStatusUrl(input: MutationInput, confirmationCode: string): string {
  const options = defaultUrlOptions(input.url, domainConfig(process.env));
  return `${options.protocol}://${options.host}/instagram/data_deletion/${confirmationCode}`;
}

registerMutations(
  {
    method: "POST",
    pattern: "/instagram/deauthorize",
    options: OPTIONS,
    skipForgeryProtection: true,
    run: async (input): Promise<ActionResult> => {
      const userId = signedRequestUserId(input, new InstagramSignedRequest());
      if (userId === null) return head(BAD_REQUEST);
      // Deauthorize only ends the live link; the verification stays as shared-identity veto evidence.
      await supersedeVerifications("instagram", userId);
      await deleteWhere("user_instagram_identities", "instagram_user_id", userId);
      return head(OK);
    },
  },
  {
    method: "POST",
    pattern: "/instagram/data_deletion",
    options: OPTIONS,
    skipForgeryProtection: true,
    run: async (input): Promise<ActionResult> => {
      const signedRequest = new InstagramSignedRequest();
      const userId = signedRequestUserId(input, signedRequest);
      if (userId === null) return head(BAD_REQUEST);
      await execute(
        Prisma.sql`DELETE FROM ${table("social_connect_verifications")} WHERE ${column("social_connect_verifications", "platform")} = ${"instagram"} AND ${column("social_connect_verifications", "uid")} = ${userId}`,
      );
      await deleteWhere("user_instagram_identities", "instagram_user_id", userId);
      const confirmationCode = signedRequest.confirmationCode(userId);
      return {
        status: OK,
        body: esJson({ url: dataDeletionStatusUrl(input, confirmationCode), confirmation_code: confirmationCode }),
        contentType: JSON_TYPE,
        paramsRead: true,
      };
    },
  },
  {
    method: "POST",
    pattern: "/tiktok/deauthorize",
    options: OPTIONS,
    skipForgeryProtection: true,
    run: async (input): Promise<ActionResult> => {
      const webhook = new TiktokWebhook();
      const payload = webhook.parse(input.rawBody, input.request.headers.get("tiktok-signature"));
      if (payload === null || Object.keys(payload).length === 0) return head(BAD_REQUEST);
      if (payload.event !== "authorization.removed") return head(OK);
      const openId = webhook.openId(payload);
      if (openId === null) return head(BAD_REQUEST);
      await supersedeVerifications("tiktok", openId);
      await deleteWhere("user_tiktok_identities", "tiktok_open_id", openId);
      return head(OK);
    },
  },
);

// InstagramCallbacksController#data_deletion_status: stateless, any valid confirmation code means the deletion is done.
export function instagramDataDeletionStatus(confirmationCode: string): ActionResult {
  if (!new InstagramSignedRequest().validConfirmationCode(confirmationCode)) return head(NOT_FOUND);
  return {
    status: OK,
    body: "Instagram data deletion completed.",
    contentType: "text/plain; charset=utf-8",
    paramsRead: true,
  };
}
