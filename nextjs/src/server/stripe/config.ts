// config/initializers/003_stripe.rb, read the way Rails reads it (GlobalConfig, Rails.env).
import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";

// The version stripe 12.5.0 is pinned to by the initializer; outside the test environment the
// two beta flags ride on the same Stripe-Version header.
export const STRIPE_API_VERSION = "2023-10-16";
const STRIPE_API_VERSION_WITH_BETAS = "2023-10-16; risk_in_requirements_beta=v1; retrieve_tax_forms_beta=v1;";

export type StripeConfig = {
  apiKey: string | undefined;
  apiVersion: string;
  apiBase: string;
  // StripeConfiguration's retry settings; the initializer only raises max_network_retries.
  maxNetworkRetries: number;
  initialNetworkRetryDelay: number;
  maxNetworkRetryDelay: number;
  // Seconds, as stripe-ruby's open_timeout / read_timeout / write_timeout.
  openTimeout: number;
  readTimeout: number;
  writeTimeout: number;
  enableTelemetry: boolean;
};

export function stripeConfigFromEnv(): StripeConfig {
  return {
    apiKey: getConfig("STRIPE_API_KEY"),
    apiVersion: railsEnv() === "test" ? STRIPE_API_VERSION : STRIPE_API_VERSION_WITH_BETAS,
    apiBase: "https://api.stripe.com",
    // Ref: https://github.com/gumroad/web/issues/17770, https://stripe.com/docs/rate-limits#object-lock-timeouts
    maxNetworkRetries: 3,
    initialNetworkRetryDelay: 0.5,
    maxNetworkRetryDelay: 2,
    openTimeout: 30,
    readTimeout: 80,
    writeTimeout: 30,
    enableTelemetry: true,
  };
}

// STRIPE_PLATFORM_ACCOUNT_ID and friends, constants in Ruby; read on use here so tests can set them.
export function stripePlatformAccountId(): string | undefined {
  return getConfig("STRIPE_PLATFORM_ACCOUNT_ID");
}

export function stripeConnectClientId(): string | undefined {
  return getConfig("STRIPE_CONNECT_CLIENT_ID");
}

export function stripePublicKey(): string {
  return railsEnv() === "production"
    ? getConfig("STRIPE_PUBLIC_KEY_PROD", "pk_live_Db80xIzLPWhKo1byPrnERmym")
    : getConfig("STRIPE_PUBLIC_KEY_TEST", "pk_test_ehGPKw3JPRHYiqEEjgJ02ULC");
}
