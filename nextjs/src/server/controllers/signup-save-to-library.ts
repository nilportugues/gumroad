// SignupController#save_to_library (POST /save_to_library): the answer for a request with no `user` hash. A `user` hash builds an account
// (bcrypt digest, random tokens, confirmation mail) and attaches the purchase, which stays with Rails whole.
import { HandBackToRails } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

const INVALID_EMAIL_MESSAGE = "Please provide a valid email address.";

registerMutations({
  method: "POST",
  pattern: "/save_to_library",
  formats: ["any"],
  run: (input) => {
    // `user_params?`: only a nested hash is ActionController::Parameters; a missing, scalar or list value reads as no user params.
    const user = input.params.user;
    if (user !== null && typeof user === "object" && !Array.isArray(user))
      throw new HandBackToRails("a user hash, which creates an account");
    return Promise.resolve(jsonResponse({ success: false, error_message: INVALID_EMAIL_MESSAGE }, 200, true));
  },
});
