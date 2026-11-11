// Settings::PaymentsController#opt_in_to_au_backtax_collection (app/controllers/settings/payments_controller.rb), a Sellers::BaseController
// JSON action: a request that does not ask for JSON goes to Rails.
//
// Handed to Rails before the first write: a signature that is not text (Rails calls `length` on it only when the seller has a legal name,
// and `create!` casts the rest to a string), and one that fails `validates_presence_of` (RecordInvalid, rendered by the exceptions app).
import { railsLoggedInUser } from "../auth/resolve.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { BACKTAX_JURISDICTIONS, BacktaxAgreements } from "../models/backtax-agreement.ts";
import { COMMENT_TYPES, Comments } from "../models/comment.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { aliveUserComplianceInfoRow, legalEntityName } from "../models/user-compliance-info.ts";
import { settingsPaymentsUserPolicy } from "../policies/settings/payments-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const OPT_IN_PATH = "/settings/payments/opt_in_to_au_backtax_collection";
const EXACT_NAME_MESSAGE = "Please enter your exact name.";
const AUDIT_DESCRIPTION = "Australia backtax collection agreement signed";

// The signature must be as long, in characters, as the legal name on the seller's compliance information. A legal name of "" is
// still a name (Ruby's `""` is truthy); only a missing compliance revision or a business with no business name skips the check.
export async function signatureMatchesLegalName(sellerId: bigint, signature: string): Promise<boolean> {
  const info = await aliveUserComplianceInfoRow(sellerId);
  const name = info === null ? null : legalEntityName(info);
  return name === null || [...name].length === [...signature].length;
}

// AuditsPayoutSettingsChanges#log_payout_settings_update_by_non_owner. Best-effort: the agreement is already saved, so a failure
// here must not turn the answer into an error.
export async function logPayoutSettingsUpdateByNonOwner(input: MutationInput, description: string): Promise<void> {
  const loggedInUser = railsLoggedInUser(input.context);
  const seller = input.context.currentSeller!;
  if (loggedInUser === null || loggedInUser.id === seller.id) return;
  try {
    await Comments.createBang({
      commentable_id: seller.id,
      commentable_type: "User",
      author_id: loggedInUser.id,
      comment_type: COMMENT_TYPES.NOTE,
      content: `${description} by team admin ${loggedInUser.email ?? ""}`,
    });
  } catch (error) {
    notifyError(error, { seller_id: seller.id, actor_id: loggedInUser.id });
  }
}

function optInToAuBacktaxCollection(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    (sellerContext) =>
      settingsPaymentsUserPolicy.optInToAuBacktaxCollection(sellerContext, input.context.currentSeller!),
    async () => {
      const seller = input.context.currentSeller!;
      const { signature } = input.params;
      if (typeof signature !== "string" || /\p{Surrogate}/u.test(signature))
        throw new HandBackToRails("a signature that is not text");

      if (!(await signatureMatchesLegalName(seller.id, signature)))
        return jsonResponse({ success: false, error: EXACT_NAME_MESSAGE }, 200, true);

      try {
        await BacktaxAgreements.createBang({
          user_id: seller.id,
          jurisdiction: BACKTAX_JURISDICTIONS.AUSTRALIA,
          signature,
        });
      } catch (error) {
        if (error instanceof RecordInvalid) throw new HandBackToRails(`an invalid backtax agreement: ${error.message}`);
        throw error;
      }

      await logPayoutSettingsUpdateByNonOwner(input, AUDIT_DESCRIPTION);
      return jsonResponse({ success: true }, 200, true);
    },
  );
}

registerMutations({ method: "POST", pattern: OPT_IN_PATH, formats: ["json"], run: optInToAuBacktaxCollection });
