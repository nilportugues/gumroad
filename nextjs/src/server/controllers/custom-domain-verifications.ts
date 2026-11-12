// CustomDomain::VerificationsController#create on `POST /custom_domain/verify`: Pundit's Settings::Advanced::UserPolicy#show?, then
// CustomDomainVerificationService over node:dns. It writes nothing. A `product_id` also validates the product's custom domain (or a new
// one) with the requested domain, and a domain that DNS accepts but the model refuses answers with the model's first error.
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { aliveCustomDomainOfProduct, CustomDomains } from "../models/custom-domain.ts";
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";
import { customDomainPointsToGumroad } from "../services/custom-domain-verification.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";

const NOT_CONFIGURED_PREFIX =
  "Domain verification failed. Please make sure you have correctly configured the DNS record for ";
// Printable ASCII without the characters String#inspect escapes (quote, backslash, `#`) or JSON rendering may escape (`<`, `>`, `&`).
const INSPECT_PLAIN = /^[ !$%'()*+,\-./0-9:;=?@A-Z[\]^_`a-z{|}~]*$/u;

// `product.custom_domain || product.build_custom_domain`, given `custom_domain.domain = params[:domain]`, then `valid?`: the first error's
// message, null when it is valid, and undefined when there is no such product (which fails the check without a message of its own).
async function productDomainError(productId: string, domain: string | null): Promise<string | null | undefined> {
  const id = decrypt(productId);
  const product = id === null ? null : await db.link.findFirst({ where: { id: BigInt(id) } });
  if (product === null) return undefined;
  const existing = await aliveCustomDomainOfProduct(product.id);
  let record = existing;
  if (record === null) {
    // A new row is validated through its owner: `user_or_product_present` is met by the product, so the seller has to be there.
    if (product.user_id === null || (await db.user.findFirst({ where: { id: product.user_id } })) === null)
      throw new HandBackToRails("a product without a seller");
    record = CustomDomains.build({ user_id: Number(product.user_id) });
  }
  record.set("domain", domain);
  if (await CustomDomains.valid(record)) return null;
  return record.errors.fullMessages()[0] ?? "";
}

async function verify(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, settingsAdvancedUserPolicy.show, async () => {
    const { domain, product_id: productId } = input.params;
    if (productId !== undefined && productId !== null && typeof productId !== "string")
      throw new HandBackToRails("a product_id that is not text");
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
    const notConfigured = { success: false, message: `${NOT_CONFIGURED_PREFIX}${domain ?? ""}.` };
    if (!valid) return jsonResponse(notConfigured, 200, true);
    // The model is only consulted once DNS has passed, so a domain that fails there needs no validation to answer.
    const error = typeof productId === "string" ? await productDomainError(productId, domain ?? null) : null;
    if (error === null)
      return jsonResponse({ success: true, message: `${String(domain)} domain is correctly configured!` }, 200, true);
    return jsonResponse(error === undefined ? notConfigured : { success: false, message: error }, 200, true);
  });
}

registerMutations({ method: "POST", pattern: "/custom_domain/verify", formats: ["json"], run: verify });
