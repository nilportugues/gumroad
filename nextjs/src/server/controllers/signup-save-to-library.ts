// SignupController#save_to_library (POST /save_to_library): creates the account from the `user` hash without signing it in. Attaching a
// purchase stays with Rails whole.
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
    if (isPresent(user.purchase_id)) throw new HandBackToRails("a purchase to attach to the new account");
    if ("remember_me" in user) throw new HandBackToRails("the remember-me checkbox");

    const { user: record } = await buildSignupUser(input, user);
    if (await Users.save(record)) return jsonResponse({ success: true }, 200, true);
    return jsonResponse({ success: false, error_message: record.errors.fullMessages()[0] ?? null }, 200, true);
  },
});
