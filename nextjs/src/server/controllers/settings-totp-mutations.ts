// Settings::TotpController (app/controllers/settings/totp_controller.rb), a Sellers::BaseController JSON controller: a request that does
// not ask for JSON goes to Rails.
//
// Ported: the guard answers (422 "already enabled" / "not enabled" / "No pending TOTP setup found.") and #destroy of a confirmed credential.
// Handed to Rails before the first write, because the answer cannot be reproduced byte for byte or depends on the clock:
//   - #create and #regenerate_recovery_codes on their success path: a random secret and random recovery codes (bcrypt-hashed, so the
//     rows differ on every run), plus the QR code.
//   - #confirm of a pending credential: a valid code depends on the time of the request, and a valid one generates recovery codes.
import { db } from "../../lib/db.ts";
import { settingsTotpUserPolicy } from "../policies/settings/totp-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const UNPROCESSABLE = 422;
const ALREADY_ENABLED = "Authenticator app is already enabled.";
const NOT_ENABLED = "Authenticator app is not enabled.";
const NO_PENDING_SETUP = "No pending TOTP setup found.";

const failure = (message: string): ActionResult =>
  jsonResponse({ success: false, error_message: message }, UNPROCESSABLE);

// `current_seller`'s credential; `totp_enabled?` is `totp_credential&.confirmed? == true`.
function totpAction(
  input: MutationInput,
  run: (credential: { id: bigint; confirmed_at: Date | null } | null) => ActionResult | Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    (sellerContext) => settingsTotpUserPolicy.create(sellerContext),
    async () => run(await db.totpCredential.findUnique({ where: { user_id: input.context.currentSeller!.id } })),
  );
}

const create = (input: MutationInput) =>
  totpAction(input, (credential) => {
    if (credential?.confirmed_at) return failure(ALREADY_ENABLED);
    throw new HandBackToRails("starting authenticator setup, which generates a random secret");
  });

const confirm = (input: MutationInput) =>
  totpAction(input, (credential) => {
    if (!credential || credential.confirmed_at) return failure(NO_PENDING_SETUP);
    throw new HandBackToRails("confirming an authenticator code, which depends on the time of the request");
  });

const destroy = (input: MutationInput) =>
  totpAction(input, async (credential) => {
    if (!credential?.confirmed_at) return failure(NOT_ENABLED);
    await db.totpCredential.delete({ where: { id: credential.id } });
    return jsonResponse({ success: true });
  });

const regenerateRecoveryCodes = (input: MutationInput) =>
  totpAction(input, (credential) => {
    if (!credential?.confirmed_at) return failure(NOT_ENABLED);
    throw new HandBackToRails("regenerating recovery codes, which are random");
  });

registerMutations(
  { method: "POST", pattern: "/settings/totp", formats: ["json"], run: create },
  { method: "POST", pattern: "/settings/totp/confirm", formats: ["json"], railsOnly: "/params:/settings/totp/confirm:post", run: confirm },
  { method: "DELETE", pattern: "/settings/totp", formats: ["json"], run: destroy },
  {
    method: "POST",
    pattern: "/settings/totp/regenerate_recovery_codes",
    formats: ["json"],
    run: regenerateRecoveryCodes,
  },
);
