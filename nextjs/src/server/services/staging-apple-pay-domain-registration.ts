// Port of app/services/staging_apple_pay_domain_registration.rb.
import { railsEnv } from "../infra/rails-env.ts";
import type { RequestOptions } from "../stripe/client.ts";
import { PaymentMethodDomain } from "../stripe/resources.ts";

export type ApplePayRegistrationResult = { active: boolean; message: string };

// Staging branch deployments only. Reads ENV directly, as Ruby does (not GlobalConfig).
export function applicable(): boolean {
  return railsEnv() === "staging" && process.env.BRANCH_DEPLOYMENT === "true" && /[^\s]/u.test(process.env.CUSTOM_DOMAIN ?? "");
}

// Object#try on a StripeObject: nil unless the key is there.
function tryKey(object: unknown, key: string): unknown {
  return object !== null && typeof object === "object" && key in object ? (object as Record<string, unknown>)[key] : null;
}

export async function register(opts: RequestOptions = {}): Promise<ApplePayRegistrationResult> {
  const domain = process.env.CUSTOM_DOMAIN ?? "";
  const created = await PaymentMethodDomain.create({ domain_name: domain }, opts);
  const validated = await PaymentMethodDomain.validate(created.id, {}, opts);
  // `pm_domain.apple_pay.status` raises NoMethodError when Stripe leaves apple_pay out.
  if (validated.apple_pay == null) throw new TypeError("undefined method 'status' for nil");
  const status = validated.apple_pay.status as unknown;
  const statusText = status == null ? "" : String(status);
  const error = statusText === "active" ? null : tryKey(tryKey(validated.apple_pay, "status_details"), "error_message");
  return {
    active: status === "active",
    message: [`Apple Pay on ${domain}: ${statusText}`, ...(error == null ? [] : [String(error)])].join(" — "),
  };
}
