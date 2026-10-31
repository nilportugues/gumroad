// Port of config/initializers/session_store.rb and the cookie options Rails derives from it.
import { createHash } from "node:crypto";

import { getConfig } from "../infra/config";
import { deriveRailsCookieSecrets, type RailsCookieSecrets } from "./rails-cookies";

const BASE_SESSION_COOKIE_NAME = "_gumroad_app_session";
const BRANCH_COOKIE_SUFFIX_LENGTH = 32;
const DEFAULT_TLD_LENGTH = 2;
const STAGING_TLD_LENGTH = 3; // username.staging.gumroad.com
const SESSION_EXPIRE_AFTER_SECONDS = 30 * 24 * 60 * 60; // 1.month in seconds
const TEST_SESSION_EXPIRE_AFTER_SECONDS = 10 * 365 * 24 * 60 * 60;

// Devise defaults; Gumroad sets no rememberable_options, so the cookie is host-only.
export const REMEMBER_COOKIE_NAME = "remember_user_token";
export const CURRENT_SELLER_COOKIE_NAME = "current_seller_id";
export const DASHBOARD_PREFERENCE_COOKIE_NAME = "last_viewed_dashboard";

export type RailsEnv = { railsEnv: string; branchDeployment: boolean; domain: string | undefined };

export function railsEnv(): RailsEnv {
  return {
    railsEnv: getConfig("RAILS_ENV") ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
    branchDeployment: Boolean(getConfig("BRANCH_DEPLOYMENT")),
    domain: getConfig("DOMAIN"),
  };
}

export function railsSessionCookieName({ railsEnv: env, branchDeployment, domain }: RailsEnv = railsEnv()): string {
  switch (env) {
    case "production":
      return BASE_SESSION_COOKIE_NAME;
    case "staging":
      if (branchDeployment) {
        if (!domain) throw new Error("DOMAIN is required for branch deployments");
        return `${BASE_SESSION_COOKIE_NAME}_${createHash("sha256").update(domain).digest("hex").slice(0, BRANCH_COOKIE_SUFFIX_LENGTH)}`;
      }
      return `${BASE_SESSION_COOKIE_NAME}_staging`;
    default:
      return `${BASE_SESSION_COOKIE_NAME}_${env}`;
  }
}

// ActionDispatch::Cookies::CookieJar#handle_options for `domain: :all` with the session store's
// tld_length. Undefined means a host-only cookie, as Rails sends for IPs and single-label hosts.
export function railsSessionCookieDomain(host: string, env: RailsEnv = railsEnv()): string | undefined {
  if (env.railsEnv === "staging" && env.branchDeployment && env.domain) return `.${env.domain}`;
  const hostname = host.replace(/:\d+$/, "");
  const labels = hostname.split(".");
  if (/^[\d.]+$/.test(hostname) || labels.includes("") || labels.length === 1) return undefined;
  const tldLength = env.railsEnv === "staging" ? STAGING_TLD_LENGTH : DEFAULT_TLD_LENGTH;
  return labels.length >= tldLength ? labels.slice(-tldLength).join(".") : undefined;
}

export function railsSessionExpireAfterSeconds(env: RailsEnv = railsEnv()): number {
  return env.railsEnv === "test" ? TEST_SESSION_EXPIRE_AFTER_SECONDS : SESSION_EXPIRE_AFTER_SECONDS;
}

export type CookieOptions = {
  domain?: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  expires?: Date;
};

// What Rails sends with the session cookie: httponly (Rack session default), SameSite=Lax
// (load_defaults 6.1), and Secure only in production, as session_store.rb sets it.
export function railsSessionCookieOptions(host: string, env: RailsEnv = railsEnv()): CookieOptions {
  return { domain: railsSessionCookieDomain(host, env), path: "/", httpOnly: true, secure: env.railsEnv === "production", sameSite: "lax" };
}

let cachedSecrets: { secretKeyBase: string; secrets: RailsCookieSecrets } | undefined;

// SECRET_KEY_BASE is what Rails 8.1 reads before credentials; Next must share Rails' value.
export function railsCookieSecrets(): RailsCookieSecrets {
  const secretKeyBase = getConfig("SECRET_KEY_BASE");
  if (!secretKeyBase) throw new Error("Missing config SECRET_KEY_BASE (must match the Rails app)");
  if (cachedSecrets?.secretKeyBase !== secretKeyBase) cachedSecrets = { secretKeyBase, secrets: deriveRailsCookieSecrets(secretKeyBase) };
  return cachedSecrets.secrets;
}
