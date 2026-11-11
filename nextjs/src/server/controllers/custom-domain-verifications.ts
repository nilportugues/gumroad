// CustomDomain::VerificationsController#create on `POST /custom_domain/verify`: Pundit's Settings::Advanced::UserPolicy#show?, then
// CustomDomainVerificationService over node:dns. It reads and writes nothing in the database. A `product_id` also runs the model validations
// of a product's custom domain (format, certificate eligibility, uniqueness), which Node's CustomDomain model does not carry, so it goes to Rails.
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";
import { customDomainPointsToGumroad } from "../services/custom-domain-verification.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";

async function verify(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, settingsAdvancedUserPolicy.show, async () => {
    const { domain, product_id: productId } = input.params;
    if (productId !== undefined && productId !== null)
      throw new HandBackToRails("a product's custom domain, whose model validations stay in Rails");
    if (domain !== undefined && domain !== null && typeof domain !== "string")
      throw new HandBackToRails("a domain that is not a string");

    const valid = await customDomainPointsToGumroad(domain ?? null);
    const body = valid
      ? { success: true, message: `${String(domain)} domain is correctly configured!` }
      : {
          success: false,
          message: `Domain verification failed. Please make sure you have correctly configured the DNS record for ${domain ?? ""}.`,
        };
    return jsonResponse(body, 200, true);
  });
}

registerMutations({ method: "POST", pattern: "/custom_domain/verify", formats: ["json"], run: verify });
