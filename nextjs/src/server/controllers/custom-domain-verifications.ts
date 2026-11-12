// CustomDomain::VerificationsController#create on `POST /custom_domain/verify`: Pundit's Settings::Advanced::UserPolicy#show?, then
// CustomDomainVerificationService over node:dns. It reads and writes nothing in the database. A `product_id` also runs the model validations
// of a product's custom domain (format, certificate eligibility, uniqueness), which Node's CustomDomain model does not carry, so it goes to Rails.
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";
import { customDomainPointsToGumroad } from "../services/custom-domain-verification.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";

const NOT_CONFIGURED_PREFIX =
  "Domain verification failed. Please make sure you have correctly configured the DNS record for ";
// Printable ASCII without the characters String#inspect escapes (quote, backslash, `#`) or JSON rendering may escape (`<`, `>`, `&`).
const INSPECT_PLAIN = /^[ !$%'()*+,\-./0-9:;=?@A-Z[\]^_`a-z{|}~]*$/u;

async function verify(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, settingsAdvancedUserPolicy.show, async () => {
    const { domain, product_id: productId } = input.params;
    if (productId !== undefined && productId !== null)
      throw new HandBackToRails("a product's custom domain, whose model validations stay in Rails");
    // PublicSuffix.parse raises on a list, `process` rescues it into "not configured" before any DNS lookup, and the message interpolates
    // the list's Array#to_s. Only strings whose String#inspect is the plain quoted text are rendered here; anything else stays in Rails.
    if (
      Array.isArray(domain) &&
      domain.length > 0 &&
      domain.every((entry) => typeof entry === "string" && INSPECT_PLAIN.test(entry))
    ) {
      const inspected = `[${domain.map((entry) => `"${String(entry)}"`).join(", ")}]`;
      return jsonResponse({ success: false, message: `${NOT_CONFIGURED_PREFIX}${inspected}.` }, 200, true);
    }
    if (domain !== undefined && domain !== null && typeof domain !== "string")
      throw new HandBackToRails("a domain that is not a string");

    const valid = await customDomainPointsToGumroad(domain ?? null);
    const body = valid
      ? { success: true, message: `${String(domain)} domain is correctly configured!` }
      : {
          success: false,
          message: `${NOT_CONFIGURED_PREFIX}${domain ?? ""}.`,
        };
    return jsonResponse(body, 200, true);
  });
}

registerMutations({ method: "POST", pattern: "/custom_domain/verify", formats: ["json"], run: verify });
