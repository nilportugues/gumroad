// Sellers::BrandAccountsController#create (POST /sellers/brand_accounts, app/controllers/sellers/brand_accounts_controller.rb): the
// account switcher's "new Gumroad". Node answers the refusals ahead of the first write: the feature off for the user, an unconfirmed
// email, and a new account that reuses the creator's email. Creating the account (a User row with a random password and its
// confirmation mail, the owner and admin team memberships, the copy of the payout setup, the Stripe account job) and
// the switch into it hand back whole.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { accountEmailRequired } from "./seller-json.ts";

const BRAND_ACCOUNTS_FEATURE = "brand_accounts";
const NOT_AVAILABLE = "Creating a new Gumroad is not available for your account yet.";
const UNCONFIRMED = "Please confirm your email address before creating a new Gumroad.";
const OWN_EMAIL_REQUIRED = "The new account needs its own email address, different from your current account.";
const ASCII_ONLY = /^[^\u0080-\u{10ffff}]*$/u;

// Ruby's String#strip
const rubyStrip = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");

async function create(input: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("a signed-out request");
  const missingEmail = accountEmailRequired(input);
  if (missingEmail) return missingEmail;

  if (!(await isFeatureEnabled(BRAND_ACCOUNTS_FEATURE, userActor(user.id))))
    return json({ success: false, error_message: NOT_AVAILABLE });
  if (user.confirmed_at == null) return json({ success: false, error_message: UNCONFIRMED });

  // params.require(:brand_account).permit(:email, ...): a missing hash is a 400, and only scalars are permitted.
  const attributes = input.params.brand_account;
  if (
    typeof attributes !== "object" ||
    attributes === null ||
    Array.isArray(attributes) ||
    Object.keys(attributes).length === 0
  )
    throw new HandBackToRails("a brand_account that is not a non-empty hash");
  const email = (attributes as Record<string, unknown>).email;
  if (email !== undefined && email !== null && typeof email !== "string")
    throw new HandBackToRails("an email that is not text");

  // `@email.to_s.strip.casecmp?(creator.email.to_s)`: Unicode case folding, which only ASCII text can be judged for here.
  const creatorEmail = user.email ?? "";
  const given = rubyStrip(email ?? "");
  if (!ASCII_ONLY.test(given) || !ASCII_ONLY.test(creatorEmail)) throw new HandBackToRails("a non-ASCII email");
  if (given.toLowerCase() === creatorEmail.toLowerCase())
    return json({ success: false, error_message: OWN_EMAIL_REQUIRED });

  throw new HandBackToRails("creating the brand account");
}

registerMutations({ method: "POST", pattern: "/sellers/brand_accounts", json: true, run: create });
