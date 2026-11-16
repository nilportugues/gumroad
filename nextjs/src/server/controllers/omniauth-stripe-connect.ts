// Port of app/controllers/user/omniauth_callbacks_controller.rb#stripe_connect for a seller who is signed in (omniauth-stripe-connect's callback
// phase, then the action). The request phase and the checks that end in the failure action are omniauth-phases.ts's.
//
// Stripe's code is single-use and a visitor who is not signed in is judged (sign in, sign up, refuse) from the account the exchange returns, so
// that callback goes to Rails before the code is spent, like every shape below that Node cannot finish. For a signed-in seller the action writes
// nothing but the session, which is why it can run after the spend.
import { notifyError } from "../infra/error-reporting.ts";
import { mapping, COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT } from "../models/compliance-countries.ts";
import { stripeConnectAccountOf } from "../models/stripe-merchant-account-disconnect.ts";
import { domainConfig } from "../page-props/domain.ts";
import { Account } from "../stripe/resources.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { type MutationInput } from "./mutation.ts";
import { authFailure, type CodeCallbackContext, registerCodeCallback, stringParam } from "./omniauth-phases.ts";
import { safeRedirectPath } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { exchangeStripeConnect } from "./social-connect-exchange.ts";

const STRATEGY = "stripe_connect";
const FOUND = 302;
const INTERNAL_ERROR = "internal_error";
const SETTINGS_PAYMENTS_PATH = "/settings/payments";
const OAUTH_COMPLETIONS_STRIPE_PATH = "/oauth_completions/stripe";
const ALREADY_CONNECTED = "This seller already has another Stripe account connected with Gumroad.";

// What changes the request Rails would have answered differently, all judged before the code is spent.
function assertFinishable(input: MutationInput): string {
  const { chain } = input;
  const { context } = chain.auth;
  if (!context.loggedInUser || context.impersonatedUser)
    throw new HandBackToRails("a visitor who is not signed in, or who is impersonating");
  if (chain.auth.effects.signOut || chain.auth.authenticatedVia === "remember_cookie")
    throw new HandBackToRails("a visitor Devise signs in or out on the way");
  const code = stringParam(input, "code");
  if (code === undefined || !isPresent(code)) throw new HandBackToRails("a callback without a code");
  if (/XMLHttpRequest/iu.test(input.request.headers.get("x-requested-with") ?? ""))
    throw new HandBackToRails("an XHR callback");
  // The failure action reads these two, and the exchange may fail.
  if (stringParam(input, "state") === "async_link_twitter_account")
    throw new HandBackToRails("the async Twitter link page, an ERB view");
  const description = stringParam(input, "error_description");
  if (description !== undefined && isPresent(description))
    throw new HandBackToRails("a callback with an error description");
  return code;
}

async function callback(input: MutationInput, context: CodeCallbackContext): Promise<ActionResult> {
  const { chain } = input;
  const code = assertFinishable(input);
  const { rootDomain } = domainConfig(process.env);
  const referer = typeof context.omniauthParams.referer === "string" ? context.omniauthParams.referer : null;
  const redirectTo = (target: string | null) => safeRedirectPath(target, chain.request, { rootDomain });

  // From here the code is spent.
  try {
    const login = await exchangeStripeConnect(code, context.callbackUrl, chain.now);
    if (!login.ok) return authFailure(STRATEGY, input, login.type, login.type);

    const seller = chain.auth.context.currentSeller;
    if (seller && (await stripeConnectAccountOf(seller.id)) !== null)
      return { status: FOUND, location: redirectTo(SETTINGS_PAYMENTS_PATH), flash: { alert: ALREADY_CONNECTED } };

    const account = await Account.retrieve(login.uid as string | null);
    if (!COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT.includes(account.country ?? "")) {
      const name = mapping().find(([alpha2]) => alpha2 === account.country)?.[1] ?? "";
      return {
        status: FOUND,
        location: redirectTo(referer),
        flash: { alert: `Sorry, Stripe Connect is not supported in ${name} yet.` },
      };
    }

    chain.session.data.stripe_connect_data = { auth_uid: login.uid, referer, signup: false };
    return { status: FOUND, location: redirectTo(OAUTH_COMPLETIONS_STRIPE_PATH) };
  } catch (error) {
    notifyError(error);
    return authFailure(STRATEGY, input, INTERNAL_ERROR, INTERNAL_ERROR);
  }
}

registerCodeCallback(STRATEGY, callback);
