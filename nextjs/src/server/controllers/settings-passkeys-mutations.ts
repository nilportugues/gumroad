// Settings::PasskeysController (app/controllers/settings/passkeys_controller.rb), a Sellers::BaseController JSON controller: a request
// that does not ask for JSON goes to Rails.
//
// Ported: the owner-only 401, the 403 without an email, the 404 of an unknown passkey, the limit refusal of #registration_options,
// #update (rename) and #destroy.
// Handed to Rails before the first write: #registration_options under the limit (a random WebAuthn challenge kept in the session), all
// of #create (it consumes that challenge and verifies the attestation) and a rename whose nickname is not text.
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { iso8601 } from "../page-props/communities/communities.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { settingsPasskeysUserPolicy } from "../policies/settings/passkeys-user.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const UNPROCESSABLE = 422;
const MAX_PER_USER = 10;
const MAX_NICKNAME_LENGTH = 100;
const MAX_PER_USER_ERROR_MESSAGE = `You can add up to ${MAX_PER_USER} passkeys.`;
const UPDATE_ERROR_MESSAGE = "Could not update this passkey.";
// String#strip: null and ASCII whitespace.
const RUBY_STRIP = /^[\0\t-\r ]+|[\0\t-\r ]+$/gu;

type Credential = { id: bigint; nickname: string; created_at: Date; last_used_at: Date | null };

const failure = (message: string): ActionResult =>
  jsonResponse({ success: false, error_message: message }, UNPROCESSABLE, true);

const passkeyProps = (externalId: string, credential: Credential) => ({
  id: externalId,
  nickname: credential.nickname,
  created_at: iso8601(credential.created_at),
  last_used_at: credential.last_used_at ? iso8601(credential.last_used_at) : null,
});

const registrationOptions = (input: MutationInput) =>
  sellerJsonAction(input, settingsPasskeysUserPolicy.registrationOptions, async () => {
    const count = await db.webauthnCredential.count({ where: { user_id: input.context.currentSeller!.id } });
    if (count >= MAX_PER_USER) return failure(MAX_PER_USER_ERROR_MESSAGE);
    throw new HandBackToRails("passkey registration options, which carry a random challenge stored in the session");
  });

const create = (input: MutationInput) =>
  sellerJsonAction(input, settingsPasskeysUserPolicy.create, () => {
    throw new HandBackToRails("a passkey registration, which verifies an attestation against the session challenge");
  });

// `set_webauthn_credential`: `@user.webauthn_credentials.find_by_external_id(params[:id]) || e404`, after `authorize`.
function credentialAction(
  input: MutationInput,
  policy: (context: SellerContext) => boolean,
  run: (credential: Credential) => Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(input, policy, async () => {
    const id = decrypt(input.routeParams.id!);
    const credential =
      id === null
        ? null
        : await db.webauthnCredential.findFirst({
            where: { id: BigInt(id), user_id: input.context.currentSeller!.id },
            select: { id: true, nickname: true, created_at: true, last_used_at: true },
          });
    if (credential === null) throw new RoutingError("Not Found");
    return run(credential);
  });
}

const update = (input: MutationInput) =>
  credentialAction(input, settingsPasskeysUserPolicy.update, async (credential) => {
    const requested = input.params.nickname;
    if (requested !== undefined && requested !== null && typeof requested !== "string")
      throw new HandBackToRails("a passkey nickname that is not text");
    const nickname = (requested ?? "").replace(RUBY_STRIP, "");
    if (nickname === "" || [...nickname].length > MAX_NICKNAME_LENGTH) return failure(UPDATE_ERROR_MESSAGE);

    // An unchanged name is no write: `updated_at` stays.
    if (nickname !== credential.nickname)
      await db.webauthnCredential.update({ where: { id: credential.id }, data: { nickname, updated_at: new Date() } });
    return jsonResponse(
      { success: true, passkey: passkeyProps(input.routeParams.id!, { ...credential, nickname }) },
      200,
      true,
    );
  });

const destroy = (input: MutationInput) =>
  credentialAction(input, settingsPasskeysUserPolicy.destroy, async (credential) => {
    await db.webauthnCredential.delete({ where: { id: credential.id } });
    return jsonResponse({ success: true }, 200, true);
  });

const ID = ":id([A-Za-z0-9_=-]+)";

registerMutations(
  { method: "POST", pattern: "/settings/passkeys/registration_options", formats: ["json"], run: registrationOptions },
  { method: "POST", pattern: "/settings/passkeys", formats: ["json"], run: create },
  { method: "PUT", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: update },
  { method: "PATCH", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: update },
  { method: "DELETE", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: destroy },
);
