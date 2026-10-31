// Port of app/models/mailer_info.rb and app/models/mailer_info/{delivery_method,encryption,
// header_builder,router}.rb, with the credentials config/initializers/mailer.rb builds.
// application-mailer.golden.json (generate-application-mailer-golden.rb) pins every function here.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { isFeatureEnabled } from "../infra/flipper.ts";
import { railsEnv, type RailsEnv } from "../infra/rails-env.ts";
import { getRedis } from "../infra/redis.ts";
import { inspect, MailArgumentNotPortedError, type RubyValue } from "./ruby-value.ts";

export const EMAIL_PROVIDER_SENDGRID = "sendgrid";
export const EMAIL_PROVIDER_RESEND = "resend";
export type EmailProvider = typeof EMAIL_PROVIDER_SENDGRID | typeof EMAIL_PROVIDER_RESEND;

export const SENDGRID_X_SMTPAPI_HEADER = "X-SMTPAPI";

export const MAIL_DOMAINS = ["gumroad", "followers", "creators", "customers"] as const;
export type MailDomain = (typeof MAIL_DOMAINS)[number];
export type MailerLevel = "level_1" | "level_2";

// MailerInfo::FIELD_NAMES
const FIELD_NAMES = [
  "email_provider", "environment", "category", "mailer_class", "mailer_method", "mailer_args",
  "purchase_id", "charge_id", "workflow_ids", "post_id", "follower_id", "affiliate_id",
] as const;
export type MailerInfoField = (typeof FIELD_NAMES)[number];

export function headerName(name: MailerInfoField): string {
  if (!FIELD_NAMES.includes(name)) throw new Error(`Invalid header field: ${name}`);
  return `X-GUM-${name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-")}`;
}

// --- config/initializers/mailer.rb -------------------------------------------------------------------

// config/domain.rb's default_email_domain.
export function defaultEmailDomain(env: RailsEnv = railsEnv()): string {
  return { production: "gumroad.com", staging: "staging.gumroad.com", development: "staging.gumroad.com", test: "test.gumroad.com" }[env];
}

export function mailDomains(env: RailsEnv = railsEnv()): Record<MailDomain, string> {
  const production = env === "production";
  return {
    gumroad: defaultEmailDomain(env),
    followers: production
      ? getConfig("FOLLOWER_CONFIRMATION_MAIL_DOMAIN_PROD", "followers.gumroad.com")
      : getConfig("FOLLOWER_CONFIRMATION_MAIL_DOMAIN_DEV", "staging.followers.gumroad.com"),
    creators: production
      ? getConfig("CREATOR_CONTACTING_CUSTOMERS_MAIL_DOMAIN_PROD", "creators.gumroad.com")
      : getConfig("CREATOR_CONTACTING_CUSTOMERS_MAIL_DOMAIN_DEV", "staging.creators.gumroad.com"),
    customers: production ? getConfig("CUSTOMERS_MAIL_DOMAIN_PROD", "customers.gumroad.com") : getConfig("CUSTOMERS_MAIL_DOMAIN_DEV", "staging.customers.gumroad.com"),
  };
}

export const sendgridSmtpAddress = () => getConfig("SENDGRID_SMTP_ADDRESS", "smtp.sendgrid.net");
export const resendSmtpAddress = () => getConfig("RESEND_SMTP_ADDRESS", "smtp.resend.com");

type Credential = { username: string; password: string | undefined; domain: string };
type DomainCredentials = Credential & { address: string; levels?: Record<MailerLevel, Credential> };

const API_KEYS: Record<EmailProvider, Record<MailDomain, string> & { customers_level_2: string }> = {
  sendgrid: {
    gumroad: "SENDGRID_GUMROAD_TRANSACTIONS_API_KEY",
    followers: "SENDGRID_GUMROAD_FOLLOWER_CONFIRMATION_API_KEY",
    creators: "SENDGRID_GR_CREATORS_API_KEY",
    customers: "SENDGRID_GR_CUSTOMERS_API_KEY",
    customers_level_2: "SENDGRID_GR_CUSTOMERS_LEVEL_2_API_KEY",
  },
  resend: {
    gumroad: "RESEND_DEFAULT_API_KEY",
    followers: "RESEND_FOLLOWERS_API_KEY",
    creators: "RESEND_CREATORS_API_KEY",
    customers: "RESEND_CUSTOMERS_API_KEY",
    customers_level_2: "RESEND_CUSTOMERS_LEVEL_2_API_KEY",
  },
};

// EMAIL_CREDENTIALS[provider][domain]
export function emailCredentials(provider: EmailProvider, domain: MailDomain): DomainCredentials {
  const keys = API_KEYS[provider];
  const domains = mailDomains();
  const username = provider === EMAIL_PROVIDER_SENDGRID ? "apikey" : "resend";
  const address = provider === EMAIL_PROVIDER_SENDGRID ? sendgridSmtpAddress() : resendSmtpAddress();
  const credentials: DomainCredentials = { address, username, password: getConfig(keys[domain]), domain: domains[domain] };
  if (domain === "customers") {
    credentials.levels = {
      level_1: { username, password: getConfig(keys.customers), domain: domains.customers },
      level_2: { username, password: getConfig(keys.customers_level_2), domain: domains.customers },
    };
  }
  return credentials;
}

// The delivery_method_options a mailer passes: merged over config.action_mailer.smtp_settings.
export type DeliveryMethodOptions = { address: string; domain: string; user_name: string; password: string | undefined };

// MailerInfo::DeliveryMethod.options
export function deliveryMethodOptions(domain: MailDomain, emailProvider: EmailProvider, sellerMailerLevel?: MailerLevel): DeliveryMethodOptions {
  if (!MAIL_DOMAINS.includes(domain)) throw new Error(`Invalid domain: ${String(domain)}`);
  if (sellerMailerLevel !== undefined && domain !== "customers") throw new Error("Seller is only allowed for customers domain");
  const credentials = emailCredentials(emailProvider, domain);
  const level = sellerMailerLevel === undefined ? credentials : credentials.levels![sellerMailerLevel];
  return { address: credentials.address, domain: level.domain, user_name: level.username, password: level.password };
}

export const defaultDeliveryMethodOptions = (domain: MailDomain) => deliveryMethodOptions(domain, EMAIL_PROVIDER_SENDGRID);

export const isResend = (settings: { address?: string } | null | undefined) => settings?.address !== undefined && settings.address === resendSmtpAddress();

// MailerInfo::DeliveryMethod.sendgrid_equivalent_options
export function sendgridEquivalentOptions(settings: Partial<DeliveryMethodOptions>): DeliveryMethodOptions | null {
  if (!isResend(settings)) return null;
  const domainKey = MAIL_DOMAINS.find((key) => emailCredentials(EMAIL_PROVIDER_RESEND, key).domain === settings.domain);
  if (domainKey === undefined) return null;
  const level2Password = emailCredentials(EMAIL_PROVIDER_RESEND, domainKey).levels?.level_2.password;
  const sendgrid = emailCredentials(EMAIL_PROVIDER_SENDGRID, domainKey);
  const credentials = level2Password !== undefined && settings.password === level2Password ? sendgrid.levels!.level_2 : sendgrid;
  return { address: sendgrid.address, domain: credentials.domain, user_name: credentials.username, password: credentials.password };
}

// MailerInfo::UNITED_INTERNET_RECIPIENT_DOMAINS
const UNITED_INTERNET_RECIPIENT_DOMAINS = ["web.de", "gmx.de", "gmx.net", "gmx.com", "gmx.at", "gmx.ch", "gmx.us", "gmx.fr", "gmx.es", "gmx.co.uk", "mail.com"];

// MailerInfo.force_sendgrid_for_recipients?
export function forceSendgridForRecipients(recipients: string | null | undefined | (string | null | undefined)[]): boolean {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  return list.some((recipient) => {
    if (recipient === null || recipient === undefined) return false;
    // String#split drops trailing empty fields.
    const parts = rubyStrip(recipient).split("@");
    while (parts.at(-1) === "") parts.pop();
    const last = parts.at(-1) ?? "";
    const domain = rubyStrip(last.endsWith(">") ? last.slice(0, -1) : last).toLowerCase();
    return UNITED_INTERNET_RECIPIENT_DOMAINS.includes(domain);
  });
}

// String#strip: ASCII whitespace and NUL.
const rubyStrip = (value: string) => value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r \0]+$/gu, "");

// --- MailerInfo::Router -----------------------------------------------------------------------------

export type RouterDeps = {
  featureActive(name: string): Promise<boolean>;
  redisGet(key: string): Promise<string | null>;
  redisIncr(key: string): Promise<unknown>;
  // Kernel.rand
  rand(): number;
  // Date.current.to_s (config.time_zone is unset, so UTC)
  today(): string;
};

export const defaultRouterDeps = (): RouterDeps => ({
  featureActive: (name) => isFeatureEnabled(name),
  redisGet: (key) => getRedis("main").get(key),
  redisIncr: (key) => getRedis("main").incr(key),
  rand: Math.random,
  today: () => new Date().toISOString().slice(0, 10),
});

// String#to_f and String#to_i: the longest numeric prefix, 0 when there is none.
export function rubyToF(value: string | null): number {
  const match = /^[\t\n\v\f\r ]*([+-]?)(\d+(?:_\d+)*)?(?:\.(\d+(?:_\d+)*))?(?:[eE]([+-]?\d+))?/u.exec(value ?? "")!;
  const [, sign, whole, fraction, exponent] = match;
  if (whole === undefined && fraction === undefined) return 0;
  const digits = (part: string | undefined) => (part ?? "0").replaceAll("_", "");
  return Number(`${sign}${digits(whole)}.${digits(fraction)}${exponent === undefined ? "" : `e${exponent}`}`);
}

export function rubyToI(value: string | null): number {
  const match = /^[\t\n\v\f\r ]*([+-]?\d+(?:_\d+)*)/u.exec(value ?? "");
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

// MailerInfo::Router.determine_email_provider
export async function determineEmailProvider(domain: MailDomain, deps: RouterDeps = defaultRouterDeps()): Promise<EmailProvider> {
  if (!MAIL_DOMAINS.includes(domain)) throw new Error(`Invalid domain: ${String(domain)}`);
  if (!(await deps.featureActive("resend"))) return EMAIL_PROVIDER_SENDGRID;
  if (await deps.featureActive("force_resend")) return EMAIL_PROVIDER_RESEND;

  const today = deps.today();
  const currentCount = rubyToI(await deps.redisGet(`mail_router:counter:${domain}:${today}`));
  const maxCount = rubyToI(await deps.redisGet(`mail_router:max_count:${domain}:${today}`));
  // Unset counters read as 0, and 0 >= 0 keeps the domain on SendGrid.
  if (currentCount >= maxCount) return EMAIL_PROVIDER_SENDGRID;

  const randVal = deps.rand();
  const probability = rubyToF(await deps.redisGet(`mail_router:probability:${domain}:${today}`));
  if (randVal <= probability) {
    await deps.redisIncr(`mail_router:counter:${domain}:${today}`);
    return EMAIL_PROVIDER_RESEND;
  }
  return EMAIL_PROVIDER_SENDGRID;
}

// MailerInfo.random_delivery_method_options
export async function randomDeliveryMethodOptions(
  domain: MailDomain,
  options: { to?: string | null | (string | null)[]; sellerMailerLevel?: MailerLevel } = {},
  deps?: RouterDeps,
): Promise<DeliveryMethodOptions> {
  const provider = forceSendgridForRecipients(options.to) ? EMAIL_PROVIDER_SENDGRID : await determineEmailProvider(domain, deps);
  return deliveryMethodOptions(domain, provider, options.sellerMailerLevel);
}

// --- MailerInfo::Encryption ---------------------------------------------------------------------------

export type RandomIv = () => Buffer;
const defaultRandomIv: RandomIv = () => randomBytes(16);

// Only key version 1 exists.
function headerKey(): Buffer {
  const key = getConfig("MAILER_HEADERS_ENCRYPTION_KEY_V1");
  // Digest::SHA256.digest(nil) raises TypeError in Ruby.
  if (key === undefined) throw new TypeError("no implicit conversion of nil into String");
  return createHash("sha256").update(key, "utf8").digest();
}

export function encryptHeader(value: string, randomIv: RandomIv = defaultRandomIv): string {
  const iv = randomIv();
  const cipher = createCipheriv("aes-256-cbc", headerKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptHeader(value: string): string {
  const [version, iv, encrypted] = value.split(":");
  if (version !== "v1") throw new Error(`Unknown key version: ${Number.parseInt(version!.replace(/^v/u, ""), 10) || 0}`);
  const decipher = createDecipheriv("aes-256-cbc", headerKey(), Buffer.from(iv!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted!, "base64")), decipher.final()]).toString("utf8");
}

// --- MailerInfo::HeaderBuilder ----------------------------------------------------------------------

// The receipt, installment and abandoned-cart branches look up purchases and charges; the mailers
// that reach them are not ported, so they are refused rather than built without those ids.
const RECORD_MAILER_METHODS = ["purchase_installment", "follower_installment", "direct_affiliate_installment"];

function checkNoRecordIds(mailerClass: string, mailerMethod: string): void {
  if (mailerClass === "CustomerMailer" || RECORD_MAILER_METHODS.includes(mailerMethod)) {
    throw new MailArgumentNotPortedError(`MailerInfo record ids for ${mailerClass}#${mailerMethod}`);
  }
}

// HeaderBuilder#truncated_mailer_args: strings cut to 20 characters.
function truncatedMailerArgs(args: RubyValue[]): RubyValue[] {
  return args.map((argument) => (typeof argument === "string" ? Array.from(argument).slice(0, 20).join("") : argument));
}

// ActiveSupport's JSON encoding of a string: the json gem's escapes, then the HTML-safe ones.
function jsonString(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export type MailerHeaders = [string, string][];

export function buildHeaders(input: { mailerClass: string; mailerMethod: string; mailerArgs: RubyValue[]; emailProvider: EmailProvider; randomIv?: RandomIv }): MailerHeaders {
  const { mailerClass, mailerMethod, emailProvider } = input;
  checkNoRecordIds(mailerClass, mailerMethod);
  const args = inspect(truncatedMailerArgs(input.mailerArgs));
  const env = railsEnv();
  if (emailProvider === EMAIL_PROVIDER_RESEND) {
    const category = `[${[mailerClass, mailerMethod === "" ? null : `${mailerClass}.${mailerMethod}`].filter((c) => c !== null).map((c) => jsonString(c!)).join(",")}]`;
    const fields: [MailerInfoField, string][] = [
      ["environment", env],
      ["mailer_class", mailerClass],
      ["mailer_method", mailerMethod],
      ["mailer_args", args],
      ["category", category],
    ];
    return [...fields.map(([field, value]): [string, string] => [headerName(field), encryptHeader(value, input.randomIv)]), [headerName("email_provider"), EMAIL_PROVIDER_RESEND]];
  }
  const smtpApi =
    `{"environment":${jsonString(env)},"category":[${jsonString(mailerClass)},${jsonString(`${mailerClass}.${mailerMethod}`)}],` +
    `"unique_args":{"mailer_class":${jsonString(mailerClass)},"mailer_method":${jsonString(mailerMethod)},"mailer_args":${jsonString(args)}}}`;
  return [
    [headerName("email_provider"), EMAIL_PROVIDER_SENDGRID],
    [SENDGRID_X_SMTPAPI_HEADER, smtpApi],
  ];
}
