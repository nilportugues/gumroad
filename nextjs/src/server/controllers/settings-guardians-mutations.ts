// Settings::GuardiansController (app/controllers/settings/guardians_controller.rb): the refusals ahead of a save. Saving a guardian
// encrypts the tax id, attaches the row to the compliance revision, queues SyncGuardianToStripeJob and writes the audit note, so a
// request that gets past the guards goes to Rails before its first write.
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { legalGuardianRequired } from "../page-props/settings/payments.ts";
import { settingsPaymentsUserPolicy } from "../policies/settings/payments-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { jsonResponse, jsonSellerGuard } from "./seller-json-guard.ts";

const NOT_REQUIRED_MESSAGE = "A legal guardian isn't required on this account.";
const FORBIDDEN = 403;
const NOT_FOUND = 404;

// `authorize` and then `ensure_guardian_required`: someone with no right to the settings is refused before learning whether the
// seller is a minor. The route's `format: :json` default means no answer varies on Accept.
async function guard(input: MutationInput): Promise<ActionResult | null> {
  const seller = input.context.currentSeller!;
  const refused = await jsonSellerGuard(input, (context) => settingsPaymentsUserPolicy.update(context, seller));
  if (refused) return { ...refused, paramsRead: true };
  if (await legalGuardianRequired(seller)) return null;
  return { ...jsonResponse({ error: NOT_REQUIRED_MESSAGE }, FORBIDDEN), rescued: true, paramsRead: true };
}

async function create(input: MutationInput): Promise<ActionResult> {
  const refused = await guard(input);
  if (refused) return refused;
  throw new HandBackToRails("a guardian save, which queues the Stripe sync");
}

async function update(input: MutationInput): Promise<ActionResult> {
  const refused = await guard(input);
  if (refused) return refused;

  // `current_seller.guardians.alive.find_by_external_id(params[:id])`
  const id = decrypt(input.routeParams.id!);
  const guardian =
    id === null
      ? null
      : await db.guardian.findFirst({
          where: { id: BigInt(id), user_id: input.context.currentSeller!.id, deleted_at: null },
          select: { id: true },
        });
  // `head :not_found`
  if (guardian === null) return { status: NOT_FOUND, body: "", contentType: "application/json", paramsRead: true };
  throw new HandBackToRails("a guardian save, which queues the Stripe sync");
}

const ID = ":id([A-Za-z0-9_=-]+)";

registerMutations(
  { method: "POST", pattern: "/settings/guardians", formats: ["json"], run: create },
  { method: "PUT", pattern: `/settings/guardians/${ID}`, formats: ["json"], run: update },
  { method: "PATCH", pattern: `/settings/guardians/${ID}`, formats: ["json"], run: update },
);
