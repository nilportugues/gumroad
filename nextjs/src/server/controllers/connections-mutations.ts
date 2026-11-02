// ConnectionsController#unlink_youtube, #unlink_instagram and #unlink_tiktok (app/controllers/connections_controller.rb). The profile
// settings page posts them as JSON. #unlink_twitter saves the whole User (validations, callbacks, search indexing) and stays in Rails.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { notAllowedMessage, ADD_EMAIL_MESSAGE } from "../page-props/settings/guard.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { settingsProfilePolicy } from "../policies/settings/profile.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { HandBackToRails, type ActionResult, type Rendered } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;

const json = (value: unknown, status = 200): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE });

// Sellers::BaseController (RequireAccountEmail, authenticate_user!), then the controller's `authorize` for a JSON request:
// PunditAuthorization#default_user_not_authorized answers 401 JSON.
async function guarded(input: MutationInput): Promise<ActionResult | null> {
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("authenticate_user! for a signed-out visitor");
  if (!user.email && !user.unconfirmed_email && !input.context.impersonatedUser) return { ...json({ success: false, error_message: ADD_EMAIL_MESSAGE }, FORBIDDEN), rescued: true };
  const sellerContext = await loadSellerContext(input.context);
  try {
    authorize(settingsProfilePolicy.manageSocialConnections, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return { ...json({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
  }
  return null;
}

// `current_seller.<identity>&.destroy!`: the model has no callbacks beyond its `belongs_to :user`.
async function destroyIdentity(input: MutationInput, tableName: string): Promise<ActionResult> {
  const denied = await guarded(input);
  if (denied) return denied;
  const sellerId = input.context.currentSeller!.id;
  const [identity] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${column(tableName, "id")} AS id FROM ${table(tableName)} WHERE ${column(tableName, "user_id")} = ${sellerId} LIMIT 1`);
  if (identity) await execute(Prisma.sql`DELETE FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${identity.id}`);
  return json({ success: true });
}

registerMutations(
  ...(["youtube", "instagram", "tiktok"] as const).map((provider) => ({
    method: "POST",
    pattern: `/settings/connections/unlink_${provider}`,
    formats: ["json" as const],
    run: (input: MutationInput) => destroyIdentity(input, `user_${provider}_identities`),
  })),
);
