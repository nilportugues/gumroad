// Stripe::Webhook.construct_event (stripe-ruby 12.5.0, lib/stripe/webhook.rb): the HMAC check and the 300 second tolerance.
import { createHmac, timingSafeEqual } from "node:crypto";

import { NotPortedError } from "../page-props/not-ported.ts";

const EXPECTED_SCHEME = "v1";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export class SignatureVerificationError extends Error {}

// Integer(string): a plain decimal is the only form read here. Ruby also takes 0x10, 0b1, 017, 1_0 and padded strings, which this does
// not model, so any other string with a digit in it goes to Rails; one without digits is the ArgumentError Ruby raises.
function rubyInteger(value: string | undefined): number {
  if (value === undefined)
    throw new SignatureVerificationError("Unable to extract timestamp and signatures from header");
  if (/^[+-]?(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (/\d/u.test(value)) throw new NotPortedError("a Stripe-Signature timestamp that is not a plain integer");
  throw new SignatureVerificationError("Unable to extract timestamp and signatures from header");
}

export function verifyStripeHeader(
  payload: Uint8Array,
  header: string | null,
  secret: string | undefined,
  now: () => number = Date.now,
): void {
  if (header === null) throw new SignatureVerificationError("Unable to extract timestamp and signatures from header");
  const items = header.split(/,\s*/u).map((item) => {
    const index = item.indexOf("=");
    return index === -1 ? [item] : [item.slice(0, index), item.slice(index + 1)];
  });
  const timestampItem = items.find((item) => item[0] === "t");
  if (timestampItem === undefined)
    throw new SignatureVerificationError("Unable to extract timestamp and signatures from header");
  const timestamp = rubyInteger(timestampItem[1]);
  const signatures = items.filter((item) => item[0] === EXPECTED_SCHEME).map((item) => item[1]);
  if (signatures.length === 0)
    throw new SignatureVerificationError(`No signatures found with expected scheme ${EXPECTED_SCHEME}`);
  // compute_signature raises ArgumentError for a secret that is not a String, which is a 500 in Rails.
  if (secret === undefined) throw new NotPortedError("a Stripe webhook with no endpoint secret configured");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex");
  const matches = signatures.some((signature) => {
    if (signature === undefined || signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
  if (!matches) throw new SignatureVerificationError("No signatures found matching the expected signature for payload");
  if (timestamp * 1000 < now() - DEFAULT_TOLERANCE_SECONDS * 1000)
    throw new SignatureVerificationError("Timestamp outside the tolerance zone");
}
