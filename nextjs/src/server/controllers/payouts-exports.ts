// Payouts::ExportsController#create (`POST /payouts/exports`): queues ExportPayoutData, a Ruby job, for the seller's own completed
// payouts. The request reads `payments` and pushes the job; the job builds the files and sends the mail.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { balancePolicy } from "../policies/balance.ts";
import { loadSellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, type ActionOptions, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { scopedPayments } from "./payouts-exportables.ts";
import { FORBIDDEN, UNAUTHORIZED, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";

// A before_action or rescue_from answer: the after_actions do not run, and no action has read params when Vary is decided.
const halted = (value: unknown, status: number): ActionResult => ({ ...jsonResponse(value, status), rescued: true });

// `skip_before_action :check_suspended`
export const PAYOUTS_EXPORTS_OPTIONS: ActionOptions = { skip: ["check_suspended"] };

// `Array.wrap(params[:payout_ids])`; anything but strings is left to Rails.
export function externalIdsOf(param: unknown): string[] {
  if (param === undefined || param === null) return [];
  const values = Array.isArray(param) ? param : [param];
  if (!values.every((value) => typeof value === "string")) throw new HandBackToRails("payout ids that are not strings");
  return values;
}

// `current_seller.payments.completed.displayable.by_external_ids(external_ids).pluck(:id)`
async function payoutIds(sellerId: bigint, externalIds: string[]): Promise<number[]> {
  if (externalIds.length === 0) return [];
  const ids = externalIds.map((externalId) => decrypt(externalId));
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("payments", "id")} FROM ${table("payments")} WHERE ${scopedPayments(sellerId)} AND ${column("payments", "id")} IN (${Prisma.join(ids.map((id) => id ?? Prisma.sql`NULL`))}) ORDER BY ${column("payments", "id")} ASC`,
  );
  return rows.map((row) => Number(row.id));
}

async function create(input: MutationInput): Promise<ActionResult> {
  const { context } = input;
  const user = context.loggedInUser;
  const seller = context.currentSeller;
  if (user === null || seller === null) throw new HandBackToRails("a signed-out request");

  // RequireAccountEmail
  if (!user.email && !user.unconfirmed_email && !context.impersonatedUser)
    return halted({ success: false, error_message: ADD_EMAIL_MESSAGE }, FORBIDDEN);

  // load_payout_ids is a before_action, so it answers before `authorize`.
  const externalIds = externalIdsOf(input.params.payout_ids);
  const ids = await payoutIds(seller.id, externalIds);
  if (ids.length === 0 || ids.length !== externalIds.length)
    return halted({ error: "Invalid payouts" }, UNPROCESSABLE_ENTITY);

  // PunditAuthorization#default_user_not_authorized
  const sellerContext = await loadSellerContext(context);
  if (!balancePolicy.export(sellerContext))
    return halted({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED);

  // `impersonating_user&.id || logged_in_user.id` is the signed-in account either way: the admin while impersonating.
  await enqueue("ExportPayoutData", [ids, Number(user.id)]);
  // `head :ok`
  return { status: 200, body: "", contentType: "application/json", paramsRead: true };
}

registerMutations({
  method: "POST",
  pattern: "/payouts/exports",
  json: true,
  options: PAYOUTS_EXPORTS_OPTIONS,
  run: create,
});
