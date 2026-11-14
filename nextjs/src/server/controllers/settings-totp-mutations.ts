// Settings::TotpController (app/controllers/settings/totp_controller.rb), a Sellers::BaseController JSON controller: a request that does
// not ask for JSON goes to Rails.
//
// Everything runs in Node. Random values (the secret, the recovery codes and their bcrypt salts) cannot match a recording, so the parity
// replay skips them and node_output_parity_spec.rb has Rails decode what Node stored. Handed to Rails before any write: a `code` that is
// not text (ROTP raises on it).
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { QrCode } from "../../lib/qr-svg.ts";
import { provisioningUri, randomSecret, verifyTotp } from "../../lib/rotp.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import { formatRecoveryCode, generateRecoveryCodes } from "../models/totp-credential.ts";
import { settingsTotpUserPolicy } from "../policies/settings/totp-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const UNPROCESSABLE = 422;
// TotpCredential::DRIFT
const TOTP_DRIFT_SECONDS = 30;
const ALREADY_ENABLED = "Authenticator app is already enabled.";
const NOT_ENABLED = "Authenticator app is not enabled.";
const INVALID_CODE = "Invalid code. Please try again.";
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

const QR_MODULE_SIZE = 4;
const QR_OFFSET = 16;
const QR_FILL = "ffffff";
const ISSUER_NAME = "Gumroad";

// `@user.totp_credential&.destroy` then `create_totp_credential!`: a pending credential is replaced by one with a fresh secret.
const create = (input: MutationInput) =>
  totpAction(input, async (credential) => {
    if (credential?.confirmed_at) return failure(ALREADY_ENABLED);
    const seller = input.context.currentSeller!;
    const secret = randomSecret();
    const uri = provisioningUri(secret, seller.email ?? "", ISSUER_NAME);
    // Drawn before the first write: a URI no QR version can hold raises in Rails before it saves.
    const qrSvg = new QrCode(uri).asSvg({ moduleSize: QR_MODULE_SIZE, offset: QR_OFFSET, fill: QR_FILL });
    const now = new Date();
    await transaction(async () => {
      if (credential)
        await execute(
          Prisma.sql`DELETE FROM ${table("totp_credentials")} WHERE ${column("totp_credentials", "id")} = ${credential.id}`,
        );
      await execute(
        Prisma.sql`INSERT INTO ${table("totp_credentials")} (${column("totp_credentials", "user_id")}, ${column("totp_credentials", "otp_secret")}, ${column("totp_credentials", "created_at")}, ${column("totp_credentials", "updated_at")}) VALUES (${seller.id}, ${secret}, ${now}, ${now})`,
      );
    });
    return jsonResponse({ success: true, secret, provisioning_uri: uri, qr_svg: qrSvg });
  });

// `credential.with_lock`: the row is read again under FOR UPDATE, so a confirmation that raced this one is seen.
const confirm = (input: MutationInput) =>
  totpAction(input, async (credential) => {
    if (!credential || credential.confirmed_at) return failure(NO_PENDING_SETUP);
    // `params[:code]` of another type raises in `empty?` or in ROTP (a 500): left to Rails before any write.
    const code = input.params.code;
    if (code !== undefined && code !== null && typeof code !== "string")
      throw new HandBackToRails("an authenticator code that is not text");
    const now = new Date();
    const outcome = await transaction(async () => {
      const [locked] = await selectRows<{ otp_secret: string; confirmed_at: Date | null }>(
        Prisma.sql`SELECT ${column("totp_credentials", "otp_secret")}, ${column("totp_credentials", "confirmed_at")} FROM ${table("totp_credentials")} WHERE ${column("totp_credentials", "id")} = ${credential.id} LIMIT 1 FOR UPDATE`,
      );
      if (!locked || locked.confirmed_at !== null) return { result: "missing" } as const;
      if (!code || !verifyTotp(locked.otp_secret, code, TOTP_DRIFT_SECONDS, now)) return { result: "invalid" } as const;
      await execute(
        Prisma.sql`UPDATE ${table("totp_credentials")} SET ${column("totp_credentials", "confirmed_at")} = ${now}, ${column("totp_credentials", "updated_at")} = ${now} WHERE ${column("totp_credentials", "id")} = ${credential.id}`,
      );
      return { result: "ok", codes: await generateRecoveryCodes(credential.id, now) } as const;
    });
    if (outcome.result === "ok")
      return jsonResponse({ success: true, recovery_codes: outcome.codes.map(formatRecoveryCode) }, 200, true);
    if (outcome.result === "invalid")
      return jsonResponse({ success: false, error_message: INVALID_CODE }, UNPROCESSABLE, true);
    return { ...failure(NO_PENDING_SETUP), paramsRead: true };
  });

const destroy = (input: MutationInput) =>
  totpAction(input, async (credential) => {
    if (!credential?.confirmed_at) return failure(NOT_ENABLED);
    await db.totpCredential.delete({ where: { id: credential.id } });
    return jsonResponse({ success: true });
  });

const regenerateRecoveryCodes = (input: MutationInput) =>
  totpAction(input, async (credential) => {
    if (!credential?.confirmed_at) return failure(NOT_ENABLED);
    const codes = await transaction(() => generateRecoveryCodes(credential.id, new Date()));
    return jsonResponse({ success: true, recovery_codes: codes.map(formatRecoveryCode) });
  });

registerMutations(
  { method: "POST", pattern: "/settings/totp", formats: ["json"], run: create },
  { method: "POST", pattern: "/settings/totp/confirm", formats: ["json"], run: confirm },
  { method: "DELETE", pattern: "/settings/totp", formats: ["json"], run: destroy },
  {
    method: "POST",
    pattern: "/settings/totp/regenerate_recovery_codes",
    formats: ["json"],
    run: regenerateRecoveryCodes,
  },
);
