// What Settings::PaymentsController#remediation and #verify_stripe_remediation do once the guards have passed and the seller has
// a Stripe account: they read the account at Stripe, and #remediation opens an AccountLink. The calls and their order are Rails':
// one Account.retrieve (the open requirements check; skipped when the seller has a request of their own), the same read again
// only if the first one failed, then AccountLink.create.
//
// Handed to Rails whole: a Stripe failure that Rails answers with a write (the disabled reason sync after a refused link, the
// requests marked as provided) or with a 500 (#verify_stripe_remediation does not rescue). Rails then repeats the reads, which
// are free of side effects; a refused AccountLink.create is repeated too, and Stripe refuses it again.
import { notifyError } from "../infra/error-reporting.ts";
import { rubyToI } from "../mail/mailer-info.ts";
import type { MerchantAccountRow } from "../models/merchant-account.ts";
import { jsonAttr } from "../models/user-compliance-info.ts";
import { payoutsPausedBy, UserFlags, Users } from "../models/user.ts";
import { InvalidRequestError, StripeError } from "../stripe/errors.ts";
import { Account, AccountLink } from "../stripe/resources.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";

const FOUND = 302;
const PAYMENTS_PATH = "/settings/payments";
const PAYOUT_PAUSE_SOURCE_STRIPE = "stripe";
const VERIFICATION_DOCUMENT_REQUIREMENT = /\.verification\.(?:additional_)?document$/u;
const LINK_REFUSED_MESSAGE = "We couldn't open the verification page. Please contact support.";
const ALL_SET_MESSAGE = "Thanks! You're all set.";
const STRIPE_PAUSED_MESSAGE =
  "Stripe has paused payouts on your account and hasn't told us what it needs. There's nothing for you to submit right now.";
const STRIPE_REVIEWING_MESSAGE =
  "Stripe is still reviewing your account. There's nothing more for you to submit right now.";

type StripeHash = Record<string, unknown>;

const isHash = (value: unknown): value is StripeHash =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `value.present?` for what Stripe's JSON holds.
function present(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isHash(value)) return Object.keys(value).length > 0;
  return true;
}

// `Array(value)`
const rubyArray = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : isHash(value)
        ? Object.entries(value)
        : [value];

// `stripe_account["requirements"] || {}`; a value that is not a hash would raise inside Rails.
function hashOrEmpty(account: StripeHash, key: string): StripeHash {
  const value = account[key];
  if (value === undefined || value === null || value === false) return {};
  if (!isHash(value)) throw new HandBackToRails(`a Stripe account whose ${key} is not an object`);
  return value;
}

const toI = (value: unknown): number =>
  typeof value === "number" ? Math.trunc(value) : typeof value === "string" ? rubyToI(value) : 0;

// stripe_review_has_no_exit?
function reviewHasNoExit(account: StripeHash, requirements: StripeHash): boolean {
  return (
    present(requirements.pending_verification) &&
    (!account.charges_enabled || account.payouts_enabled === false) &&
    rubyArray(requirements.errors).length === 0 &&
    (!present(requirements.current_deadline) || toI(requirements.current_deadline) * 1000 < Date.now())
  );
}

// nothing_open_flash
function nothingOpenFlash(input: MutationInput, reviewStillOpen: boolean): Record<string, string> {
  const seller = input.context.currentSeller!;
  if (
    UserFlags.isSet(seller.flags, "payouts_paused_internally") &&
    payoutsPausedBy(Users.load(seller)) === PAYOUT_PAUSE_SOURCE_STRIPE
  )
    return { alert: STRIPE_PAUSED_MESSAGE };
  return reviewStillOpen ? { info: STRIPE_REVIEWING_MESSAGE } : { notice: ALL_SET_MESSAGE };
}

const toPayments = (flash?: Record<string, string>): ActionResult => ({
  status: FOUND,
  location: PAYMENTS_PATH,
  ...(flash ? { flash } : {}),
});

// GET /settings/payments/remediation, for a seller with a Stripe account whose request is not a rejection with nothing to submit.
export async function remediateStripeAccount(
  input: MutationInput,
  account: MerchantAccountRow,
  hasLocalRequests: boolean,
): Promise<ActionResult> {
  const stripeAccountId = account.charge_processor_merchant_id as string;
  const seller = input.context.currentSeller!;
  let memo: StripeHash | undefined;
  // Memoized so the open-requirements check and the link-type decision share one read.
  const retrieve = async (): Promise<StripeHash> =>
    (memo ??= (await Account.retrieve(stripeAccountId)) as unknown as StripeHash);

  async function hasOpenRequirements(): Promise<boolean> {
    try {
      const stripeAccount = await retrieve();
      const requirements = hashOrEmpty(stripeAccount, "requirements");
      const future = hashOrEmpty(stripeAccount, "future_requirements");
      const lists = [
        requirements.currently_due,
        requirements.past_due,
        requirements.eventually_due,
        future.currently_due,
        future.past_due,
        future.eventually_due,
      ];
      return lists.some(present) || reviewHasNoExit(stripeAccount, requirements);
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      notifyError(error, { user_id: Number(seller.id) });
      return false;
    }
  }

  async function linkType(): Promise<string> {
    try {
      const requirements = hashOrEmpty(await retrieve(), "requirements");
      const due = [...rubyArray(requirements.currently_due), ...rubyArray(requirements.past_due)];
      return due.some((requirement) => VERIFICATION_DOCUMENT_REQUIREMENT.test(String(requirement)))
        ? "account_onboarding"
        : "account_update";
    } catch (error) {
      // Picking the type is a refinement; a failed read must not cost the seller their link.
      if (!(error instanceof StripeError)) throw error;
      return "account_update";
    }
  }

  try {
    if (!hasLocalRequests && !(await hasOpenRequirements())) return toPayments(nothingOpenFlash(input, false));

    const { protocol, host } = input.urlOptions;
    const link = (await AccountLink.create({
      account: stripeAccountId,
      refresh_url: `${protocol}://${host}${PAYMENTS_PATH}/remediation`,
      return_url: `${protocol}://${host}${PAYMENTS_PATH}/verify_stripe_remediation`,
      type: await linkType(),
    })) as unknown as StripeHash;
    if (typeof link.url !== "string" || link.url === "") throw new HandBackToRails("an account link without a URL");
    return { status: FOUND, location: link.url };
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (
      error instanceof InvalidRequestError &&
      jsonAttr({ json_data: account.json_data as string | null }, "stripe_disabled_reason") === null
    )
      throw new HandBackToRails(
        "the sync of the disabled reason of the Stripe account, which writes the merchant account",
      );
    // Stripe has no error code for a rejected account, so Rails matches the wording.
    const message = error.message;
    if (
      error instanceof InvalidRequestError &&
      message.includes("account link cannot be created") &&
      message.includes("rejected")
    )
      return toPayments();
    notifyError(error, { user_id: Number(seller.id) });
    return toPayments({ alert: LINK_REFUSED_MESSAGE });
  }
}

// GET /settings/payments/verify_stripe_remediation, for a seller with a Stripe account.
export async function verifyStripeRemediation(
  input: MutationInput,
  account: MerchantAccountRow,
  hasPendingRequests: () => Promise<boolean>,
): Promise<ActionResult> {
  let stripeAccount: StripeHash;
  try {
    stripeAccount = (await Account.retrieve(account.charge_processor_merchant_id as string)) as unknown as StripeHash;
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    throw new HandBackToRails("a Stripe account that could not be read, which Rails does not rescue");
  }
  const requirements = hashOrEmpty(stripeAccount, "requirements");
  const future = hashOrEmpty(stripeAccount, "future_requirements");

  const hardRequirementsClear = !present(requirements.currently_due) && !present(requirements.past_due);
  if (hardRequirementsClear && (await hasPendingRequests()))
    throw new HandBackToRails("the compliance requests Stripe no longer asks for, which are marked as provided");

  const nothingOpen =
    hardRequirementsClear &&
    !present(requirements.eventually_due) &&
    !present(future.currently_due) &&
    !present(future.past_due) &&
    !present(future.eventually_due);
  return toPayments(nothingOpen ? nothingOpenFlash(input, reviewHasNoExit(stripeAccount, requirements)) : undefined);
}
