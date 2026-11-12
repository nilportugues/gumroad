// SignupController#save_to_library (POST /save_to_library): creates the account from the `user` hash without signing it in. Attaching an
// existing purchase stays with Rails whole.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { findPurchaseOrNil } from "../models/charge.ts";
import { Users } from "../models/user.ts";

import { HandBackToRails } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";
import { buildSignupUser, isHash, isPresent } from "./signup-create.ts";

const INVALID_EMAIL_MESSAGE = "Please provide a valid email address.";
const PERMITTED_KEYS = ["email", "password", "password_confirmation", "terms_accepted", "buyer_signup", "remember_me"];

registerMutations({
  method: "POST",
  pattern: "/save_to_library",
  formats: ["any"],
  run: async (input) => {
    // `user_params?`: only a nested hash is ActionController::Parameters; a missing, scalar or list value reads as no user params.
    const user = input.params.user;
    if (!isHash(user)) {
      return jsonResponse({ success: false, error_message: INVALID_EMAIL_MESSAGE }, 200, true);
    }
    if (Object.keys(user).length === 0) throw new HandBackToRails("an empty user hash, which ParameterMissing answers");
    if (!PERMITTED_KEYS.some((key) => key in user)) throw new HandBackToRails("a user hash with no permitted key");
    // `Purchase.find_by_external_id(params[:user][:purchase_id])&.attach_to_user_and_card`: an id that names no purchase attaches nothing, and
    // no card is saved here (`chargeable` is nil). Attaching a purchase that exists stays in Rails.
    if (isPresent(user.purchase_id)) {
      if (typeof user.purchase_id !== "string") throw new HandBackToRails("a purchase id that is not text");
      const id = decrypt(user.purchase_id);
      if ((await findPurchaseOrNil(id === null ? null : BigInt(id))) !== null)
        throw new HandBackToRails("a purchase to attach to the new account");
    }
    // `remember_me` is Devise's virtual attribute; without a sign-in it has nothing to remember.

    const { user: record } = await buildSignupUser(input, user);
    if (await Users.save(record)) return jsonResponse({ success: true }, 200, true);
    return jsonResponse({ success: false, error_message: record.errors.fullMessages()[0] ?? null }, 200, true);
  },
});
