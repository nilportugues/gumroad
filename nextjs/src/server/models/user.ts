// Port of app/models/user.rb with the concerns that add callbacks or validations to it: Devise
// (database_authenticatable, confirmable, recoverable, pwned_password), has_one_time_password,
// StrippedFields, JsonData, User::Validations, User::EmailNormalization, User::AsyncDeviseNotification
// and Purchase::Searchable::BuyerEmailCallbacks. Callbacks are listed in the order Rails runs them.
//
// Behaviour that needs a model or service not ported yet goes through `userCollaborators`, whose
// defaults throw NotPortedError. Those that would run after commit are also checked before any write
// (`refuse_unported_side_effects`), so a save that cannot be completed in Node fails without
// committing. models/README.md lists what is still Ruby-only.
import { createHash, randomBytes, randomInt } from "node:crypto";

import { Prisma, type User } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { getConfig } from "../infra/config.ts";
import { domainConfig } from "../infra/domain.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { isFeatureEnabled } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";
import type { EnqueueOptions, JobClass, JsonValue } from "../jobs/enqueue.ts";
import { deliverDeviseNotification } from "../mail/devise-notification.ts";

import { deletable } from "./concerns/deletable.ts";
import { currentJobsRuntime, performAsync, performBulk } from "./concerns/job-runtime.ts";
import {
  jsonData as sharedJsonData,
  jsonDataForAttr as sharedJsonDataForAttr,
  jsonGet,
  mergeJsonDataWithCurrentRow,
  setJsonDataForAttr as sharedSetJsonDataForAttr,
  toHash,
} from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import { isRubyFloat } from "./concerns/ruby-values.ts";
import { rubyJsonGenerate, rubyJsonParse } from "./concerns/serialized-columns.ts";
import { defineModel, type Callback, type CallbackContext, type SaveOptions } from "./runtime/define-model.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import { connectedTo, uncached } from "./runtime/query-cache.ts";
import { ASSOCIATION_CACHE, type ModelRecord } from "./runtime/record.ts";
import { currentTransaction, participate, type Tx } from "./runtime/transaction.ts";
import {
  isBlank,
  rubyLength,
  validatesExclusionOf,
  validatesFormatOf,
  validatesLengthOf,
  validatesNumericalityOf,
  validatesUniquenessOf,
} from "./runtime/validators.ts";
import { buildSellerProfile, findSellerProfile, SellerProfiles, type SellerProfileRecord } from "./seller-profile.ts";
import { castRow, column, connection, findInBatches, selectRows, table } from "./sql.ts";
import USER_DATA from "./user-data.generated.json" with { type: "json" };

export type UserRecord = ModelRecord<User>;

export const MAX_LENGTH_NAME = 100;
export const MAX_LENGTH_FACEBOOK_META_TAG = 100;
export const MAX_PRICE_USD_CENTS_UNLESS_VERIFIED = 500_000;
export const INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX = /:/u;
export const DELETED_ACCOUNT_HOLDS_EMAIL_ERROR =
  "This email address belonged to a Gumroad account that was deleted, so it can't be used for a new account yet. Email support@gumroad.com and we'll free it up for you.";
export const PAYOUT_FREQUENCIES = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  QUARTERLY: "quarterly",
} as const;
export const RECOMMENDATION_TYPES = USER_DATA.recommendation_types;
export const RISK_STATES = {
  SUSPENDED: ["suspended_for_tos_violation", "suspended_for_fraud"],
  FLAGGED: ["flagged_for_tos_violation", "flagged_for_fraud"],
} as const;
// User::LINK_PROPERTIES: a saved change to any of these invalidates the seller's product caches.
export const LINK_PROPERTIES = [
  "username",
  "twitter_handle",
  "bio",
  "name",
  "google_analytics_id",
  "flags",
  "facebook_pixel_id",
  "tiktok_pixel_id",
  "skip_free_sale_analytics",
  "disable_third_party_analytics",
];
// Onetime::MigrateNewsletterSubscribersToFeatureAnnouncements::NEWSLETTER_SELLER_EXTERNAL_ID
const NEWSLETTER_SELLER_EXTERNAL_ID = "6282492303727";
const GMAIL_ABUSE_REDIS_KEY = "gmail_abuse:normalized_emails";
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const RESERVED_EMAIL_DOMAINS = ["gumroad.com", "gumroad.org", "gumroad.dev"];
export const DENYLIST: readonly string[] = USER_DATA.denylist;
const TIME_ZONES: readonly (string | null)[] = [...USER_DATA.time_zones, null];
const CURRENCIES: readonly string[] = USER_DATA.currencies;
const DISPOSABLE_DOMAINS = new Set(USER_DATA.disposable_email_domains);

// Bit positions are persisted data: never renumber or reuse without resetting the column first.
export const UserFlags = defineFlags(
  "users",
  {
    1: "announcement_notification_enabled",
    2: "skip_free_sale_analytics",
    3: "purchasing_power_parity_enabled",
    4: "opt_out_simplified_pricing",
    5: "display_offer_code_field",
    6: "disable_reviews_after_year",
    7: "refund_fee_notice_shown",
    8: "refunds_disabled",
    9: "two_factor_authentication_enabled",
    10: "buyer_signup",
    11: "enforce_session_timestamping",
    12: "disable_third_party_analytics",
    13: "enable_verify_domain_third_party_services",
    14: "purchasing_power_parity_payment_verification_disabled",
    15: "bears_affiliate_fee",
    16: "enable_payment_email",
    17: "has_seen_discover",
    18: "should_paypal_payout_be_split",
    19: "pre_signup_affiliate_request_processed",
    20: "payouts_paused_internally",
    21: "disable_comments_email",
    22: "has_dismissed_upgrade_banner",
    23: "opted_into_upgrading_during_signup",
    24: "disable_reviews_email",
    25: "check_merchant_account_is_linked",
    26: "collect_eu_vat",
    27: "is_eu_vat_exclusive",
    28: "is_team_member",
    29: "has_dismissed_getting_started_checklist",
    30: "has_used_cli",
    31: "disable_paypal_sales",
    32: "all_adult_products",
    33: "enable_free_downloads_email",
    34: "enable_recurring_subscription_charge_email",
    35: "enable_payment_push_notification",
    36: "enable_recurring_subscription_charge_push_notification",
    37: "enable_free_downloads_push_notification",
    38: "million_dollar_announcement_sent",
    39: "disable_global_affiliate",
    40: "require_collab_request_approval",
    41: "payouts_paused_by_user",
    42: "opted_out_of_review_reminders",
    43: "tipping_enabled",
    44: "show_nsfw_products",
    45: "discover_boost_enabled",
    // Never read directly; User#account_level_refund_policy_enabled? owns its meaning.
    46: "refund_policy_enabled",
    47: "can_connect_stripe",
    48: "upcoming_refund_policy_change_email_sent",
    49: "DEPRECATED_can_create_physical_products",
    50: "paypal_payout_fee_waived",
    51: "dismissed_create_products_with_ai_promo_alert",
    52: "disable_affiliate_requests",
    53: "refund_policy_enforced",
    54: "disable_review_reminders",
    55: "ach_payments_enabled",
    56: "gifting_disabled",
    57: "content_moderation_disabled",
    58: "product_page_storefront_enabled",
    59: "DEPRECATED_has_dismissed_gumhead_promo",
    60: "hide_follow_form",
    61: "DEPRECATED_gumhead_enabled",
    62: "link_disabled",
    63: "paypal_card_funding_disabled",
  },
  { queryMode: "bit_operator" },
);

export type UserFlag = (typeof UserFlags.names)[number];

// ---------------------------------------------------------------------------------------------
// Collaborators: the side effects User reaches outside its own row. Tests replace them.

export class NotPortedError extends Error {
  constructor(what: string, rubyRef: string) {
    super(`${what} is not ported to Node yet (${rubyRef})`);
    this.name = "NotPortedError";
  }
}

// Ruby's NoMethodError, which callers' rescue-all reports.
export class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

const notPorted = (what: string, rubyRef: string) => async (): Promise<never> => {
  throw new NotPortedError(what, rubyRef);
};

export type DeviseNotification = "confirmation_instructions" | "email_changed";

export type UserCollaborators = {
  enqueue(jobClass: JobClass, args: JsonValue[], options?: EnqueueOptions): Promise<unknown>;
  // FooJob.perform_bulk
  enqueueBulk(jobClass: JobClass, argsList: JsonValue[][]): Promise<unknown>;
  // $redis SISMEMBER, for GmailAbuseFilter.exists?.
  sismember(key: string, member: string): Promise<number>;
  isFeatureEnabled(name: string, actor?: string | null): Promise<boolean>;
  // Pwned::Password#pwned_count. Throwing counts as "not pwned", as devise-pwned_password rescues.
  pwnedCount(password: string): Promise<number>;
  now(): Date;
  // Reads made from after_commit callbacks, which run outside the transaction.
  readDb(): Promise<Pick<Tx, "$queryRaw">>;
  randomExternalId(): string;
  friendlyToken(): string;
  otpSecret(): string;
  // Not ported yet.
  createGlobalAffiliate(user: UserRecord, ctx: CallbackContext): Promise<void>;
  createRefundPolicy(user: UserRecord, ctx: CallbackContext): Promise<void>;
  sendDeviseNotification(
    user: UserRecord,
    notification: DeviseNotification,
    args: Record<string, unknown>,
  ): Promise<void>;
  enqueueProductIndexUpdates(user: UserRecord, productIds: bigint[], changeList: string[]): Promise<void>;
  updateAudienceMembersAffiliates(user: UserRecord, sellerIds: bigint[], ctx: CallbackContext): Promise<void>;
  updateAliveCartEmail(user: UserRecord, cartId: bigint, ctx: CallbackContext): Promise<void>;
  makeRequestersAffiliates(user: UserRecord, affiliateRequestIds: bigint[]): Promise<void>;
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const DEFAULT_COLLABORATORS: UserCollaborators = {
  // FooJob.perform_async: through the job's runtime inside a Node job, else the process's.
  enqueue: (jobClass, args, options) => performAsync(jobClass, args, options),
  enqueueBulk: (jobClass, argsList) => performBulk(jobClass, argsList),
  sismember: (key, member) => getRedis("main").sismember(key, member),
  isFeatureEnabled: (name, actor) => isFeatureEnabled(name, actor),
  async pwnedCount(password) {
    // Pwned::Password: k-anonymity range lookup on the SHA1 prefix.
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    const response = await fetch(
      `${getConfig("PWNED_PASSWORDS_ORIGIN") ?? "https://api.pwnedpasswords.com"}/range/${sha1.slice(0, 5)}`,
      {
        headers: { "User-Agent": "devise_pwned_password" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`pwnedpasswords responded ${response.status}`);
    for (const line of (await response.text()).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === sha1.slice(5)) return Number(count);
    }
    return 0;
  },
  now: () => new Date(),
  readDb: () => connection() as Promise<Pick<Tx, "$queryRaw">>,
  // rand(9_999_999_999_999).to_s
  randomExternalId: () => String(randomInt(0, 9_999_999_999_999)),
  // Devise.friendly_token: SecureRandom.urlsafe_base64(15).tr("lIO0", "sxyz")
  friendlyToken: () =>
    randomBytes(15)
      .toString("base64url")
      .replace(/[lIO0]/gu, (c) => ({ l: "s", I: "x", O: "y", "0": "z" })[c]!),
  // ROTP::Base32.random(20): 20 random bytes as unpadded RFC 4648 base32.
  otpSecret() {
    const bytes = randomBytes(20);
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += BASE32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return out;
  },
  // Both models import this file, so they load on use.
  async createGlobalAffiliate(user) {
    const { GlobalAffiliates, globalAffiliateAttributes } = await import("./global-affiliate.ts");
    await GlobalAffiliates.createBang(globalAffiliateAttributes(user.get("id")));
  },
  async createRefundPolicy(user) {
    const { DEFAULT_REFUND_PERIOD_IN_DAYS, RefundPolicies } = await import("./refund-policy.ts");
    await RefundPolicies.createBang({
      seller_id: user.get("id"),
      max_refund_period_in_days: DEFAULT_REFUND_PERIOD_IN_DAYS,
    });
  },
  // User::AsyncDeviseNotification: every caller runs after the save, where Ruby sends at once.
  sendDeviseNotification: async (user, notification, args) =>
    void (await deliverDeviseNotification(
      currentJobsRuntime(),
      { id: user.get("id"), unconfirmedEmail: user.get("unconfirmed_email") },
      notification,
      args,
    )),
  // Imported on use: the product document pulls in the search stack, which plain User saves never need.
  enqueueProductIndexUpdates: async (_user, productIds, changeList) => {
    const { enqueueIndexUpdatesFor } = await import("../search/product-indexing.ts");
    await enqueueIndexUpdatesFor(productIds, changeList, {
      now: () => collaborators.now(),
      featureActive: (name, actor) => collaborators.isFeatureEnabled(name, actor),
    });
  },
  updateAudienceMembersAffiliates: notPorted(
    "AudienceMember affiliate details",
    "app/models/user.rb:1994 update_audience_members_affiliates",
  ),
  updateAliveCartEmail: notPorted("Cart#update!", "app/models/user.rb:1888 update_alive_cart_email"),
  makeRequestersAffiliates: notPorted(
    "AffiliateRequest#make_requester_an_affiliate!",
    "app/models/user.rb:1918 make_affiliate_of_the_matching_approved_affiliate_requests",
  ),
};

let collaborators: UserCollaborators = { ...DEFAULT_COLLABORATORS };

export function setUserCollaborators(overrides: Partial<UserCollaborators>): void {
  collaborators = { ...collaborators, ...overrides };
}

export function resetUserCollaborators(): void {
  collaborators = { ...DEFAULT_COLLABORATORS };
}

// Devise.friendly_token
export const deviseFriendlyToken = (): string => collaborators.friendlyToken();

// devise-pwned_password's sign-in check (Pwned::Password#pwned_count >= min_password_matches, which is 1). A failed lookup counts
// as not pwned: the gem rescues Pwned::Error.
export async function passwordIsPwned(password: string): Promise<boolean> {
  try {
    return (await collaborators.pwnedCount(password)) >= 1;
  } catch {
    return false;
  }
}

const isDefault = <K extends keyof UserCollaborators>(name: K) => collaborators[name] === DEFAULT_COLLABORATORS[name];

// ---------------------------------------------------------------------------------------------
// String helpers with Ruby semantics

// String#strip: ASCII whitespace and NUL at both ends.
export function rubyStrip(value: string): string {
  return value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");
}

// StrippedFields::StrippedField with the defaults user.rb uses.
const INVISIBLE_FORMAT_CHARS = /[­​‎‏⁠﻿]/gu;
const UNICODE_SPACES = /[   -   　]/gu;

export function strippedField(value: unknown): string | null {
  return strippedFieldWith(value, {});
}

// StrippedField.before_validation with its options: `remove_duplicate_spaces`, `nilify_blanks` and `transform` (which only
// runs on a present value).
export function strippedFieldWith(
  value: unknown,
  options: { removeDuplicateSpaces?: boolean; nilifyBlanks?: boolean; transform?: (value: string) => string },
): string | null {
  const text = value == null ? "" : String(value);
  let stripped = rubyStrip(text.replace(INVISIBLE_FORMAT_CHARS, "").replace(UNICODE_SPACES, " "));
  if (options.removeDuplicateSpaces ?? true) stripped = stripped.replace(/ {2,}/gu, " ");
  if (options.transform && !isBlank(stripped)) stripped = options.transform(stripped);
  return (options.nilifyBlanks ?? true) && isBlank(stripped) ? null : stripped;
}

// Ruby `\s` and `.` in the validators below are ASCII whitespace and "anything but \n".
const NOT_LOCAL = String.raw`[^@ \t\r\n\f\v()\[\],.<>;:\\"]`;
// EmailFormatValidator::EMAIL_REGEX
export const EMAIL_REGEX = new RegExp(
  String.raw`^(?=[^\n]{3,255}(?:\n|$))((${NOT_LOCAL}+(\.${NOT_LOCAL}+)*)|("[^\n]+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$`,
  "u",
);
// KINDLE_EMAIL_REGEX (config/initializers/aws.rb)
export const KINDLE_EMAIL_REGEX = new RegExp(
  String.raw`^(?=[^\n]{3,255}(?:\n|$))((${NOT_LOCAL}+(\.${NOT_LOCAL}+)*))@kindle\.com$`,
  "iu",
);

// EmailFormatValidator.valid?
export function isValidEmailFormat(email: unknown): boolean {
  if (isBlank(email)) return false;
  return EMAIL_REGEX.test(String(email));
}

// Mail::Address.new(value).domain (mail 2.9), for the addresses user.rb asks about. Exact for every
// address EMAIL_REGEX accepts and for `Name <addr>`; for anything else it follows the cases recorded
// in user.golden.json and returns "parse_error" where Mail raises Mail::Field::ParseError.
export function mailAddressDomain(value: string): string | null | "parse_error" {
  const angle = /^[^<>"]*<([^<>]*)>\s*$/u.exec(value);
  if (angle) return mailAddressDomain(angle[1]!);
  if (!value.includes("@")) return value.trim() === "" || /^[^\s@]+$/u.test(value) ? null : "parse_error";
  if (EMAIL_REGEX.test(value) && !value.endsWith("\n")) return value.slice(value.lastIndexOf("@") + 1);
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local === "" ||
    domain === "" ||
    domain.endsWith(".") ||
    /[\s@]/u.test(
      value
        .replace(/"[^"]*"/gu, "")
        .slice(0, at)
        .concat(domain),
    )
  )
    return "parse_error";
  return domain;
}

// NotReservedEmailDomainValidator.domain_reserved?
export function isReservedEmailDomain(email: unknown): boolean {
  if (isBlank(email)) return false;
  const domain = mailAddressDomain(String(email));
  return (
    typeof domain === "string" && domain !== "parse_error" && RESERVED_EMAIL_DOMAINS.includes(domain.toLowerCase())
  );
}

// DisposableEmailValidator.disposable?
export function isDisposableEmail(email: unknown): boolean {
  if (isBlank(email)) return false;
  const domain = String(email).split("@").at(-1)?.toLowerCase();
  return !isBlank(domain) && DISPOSABLE_DOMAINS.has(domain!);
}

// User.normalize_gmail_address
export function normalizeGmailAddress(email: string | null | undefined): string | null {
  if (isBlank(email)) return null;
  const lower = email!.toLowerCase();
  const at = lower.indexOf("@");
  const local = at === -1 ? lower : lower.slice(0, at);
  const domain = at === -1 ? "" : lower.slice(at + 1);
  if (isBlank(domain) || !GMAIL_DOMAINS.includes(domain)) return lower;
  return `${local.split("+", 2)[0]!.replaceAll(".", "")}@gmail.com`;
}

// BlockedUsernameValidator
const GAMBLING_PATTERN = new RegExp(
  [
    /onlinecasino/u,
    /casinoonline/u,
    /casino\d/u,
    /togel/u,
    /sbobet/u,
    /nhacai/u,
    /cacuoc/u,
    /sunwin/u,
    /hitclub/u,
    /789club/u,
    /slot(gacor|online|\d{2,})/u,
    /gacor/u,
    /judi(online|slot|bola)/u,
    /bandarq/u,
    /poker(online|qq|\d{2,})/u,
    /bet\d{2,}/u,
    /\d{2,}bet/u,
    /88(bet|win|club|vip|tv|com|net)/u,
    /^(go|sv|sn|m|w|fb|bk|ae|dt|qs|sc|wi|du|v9|hi|ok)(8|88|99|168|188|388|789|888|999)([a-z]{0,6})?$/u,
    /^(8x|188|12|78|23|28|122|555|68|iwin|win)(bet|win|club)$/u,
    /jeetwin/u,
    /phlwin/u,
    /kubet/u,
    /^nohu\d*$/u,
  ]
    .map((r) => `(?:${r.source})`)
    .join("|"),
  "u",
);

const BRANDS: Record<string, string[]> = {
  apple: ["apple.com"],
  google: ["google.com"],
  microsoft: ["microsoft.com"],
  amazon: ["amazon.com"],
  facebook: ["facebook.com", "meta.com"],
  instagram: ["instagram.com", "meta.com"],
  whatsapp: ["whatsapp.com", "meta.com"],
  netflix: ["netflix.com"],
  tesla: ["tesla.com"],
  walmart: ["walmart.com"],
  paypal: ["paypal.com"],
  stripe: ["stripe.com"],
  visa: ["visa.com"],
  mastercard: ["mastercard.com"],
  americanexpress: ["aexp.com", "americanexpress.com"],
  chase: ["chase.com", "jpmorgan.com", "jpmchase.com"],
  jpmorgan: ["jpmorgan.com", "jpmchase.com"],
  wellsfargo: ["wellsfargo.com"],
  bankofamerica: ["bankofamerica.com", "bofa.com"],
  citibank: ["citi.com", "citibank.com"],
  hsbc: ["hsbc.com"],
  barclays: ["barclays.com"],
  lloyds: ["lloydsbanking.com", "lloydsbank.co.uk"],
  natwest: ["natwest.com"],
  santander: ["santander.com", "santander.co.uk"],
  binance: ["binance.com"],
  coinbase: ["coinbase.com"],
  bt: ["bt.com", "bt.co.uk"],
  btinternet: ["bt.com", "bt.co.uk"],
  btbroadband: ["bt.com", "bt.co.uk"],
  ee: ["ee.co.uk", "bt.com"],
  eebroadband: ["ee.co.uk", "bt.com"],
  vodafone: ["vodafone.com", "vodafone.co.uk"],
  virginmedia: [],
  talktalk: ["talktalk.co.uk", "talktalkgroup.com"],
  att: ["att.com"],
  verizon: ["verizon.com"],
  tmobile: ["t-mobile.com"],
  comcast: ["comcast.com"],
  xfinity: ["comcast.com", "xfinity.com"],
  dhl: ["dhl.com"],
  fedex: ["fedex.com"],
  ups: ["ups.com"],
  usps: ["usps.gov", "usps.com"],
  royalmail: ["royalmail.com"],
  dpd: ["dpd.com", "dpd.co.uk"],
  nike: ["nike.com"],
  adidas: ["adidas.com"],
  puma: ["puma.com"],
  gucci: ["gucci.com"],
  louisvuitton: ["louisvuitton.com", "lvmh.com"],
  chanel: ["chanel.com"],
  rolex: ["rolex.com"],
  cocacola: ["coca-cola.com", "coke.com"],
  pepsi: ["pepsico.com", "pepsi.com"],
  mcdonalds: ["mcdonalds.com", "us.mcd.com"],
  starbucks: ["starbucks.com"],
  disney: ["disney.com", "thewaltdisneycompany.com"],
  samsung: ["samsung.com"],
  sony: ["sony.com"],
  intel: ["intel.com"],
  nvidia: ["nvidia.com"],
  oracle: ["oracle.com"],
  ibm: ["ibm.com"],
  adobe: ["adobe.com"],
  salesforce: ["salesforce.com"],
  spotify: ["spotify.com"],
  uber: ["uber.com"],
  airbnb: ["airbnb.com"],
  dropbox: ["dropbox.com"],
  shopify: ["shopify.com"],
  ebay: ["ebay.com"],
  alibaba: ["alibaba-inc.com", "alibaba.com"],
  tiktok: ["tiktok.com", "bytedance.com"],
  twitter: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com", "microsoft.com"],
  youtube: ["youtube.com", "google.com"],
  openai: ["openai.com"],
  anthropic: ["anthropic.com"],
  toyota: ["toyota.com"],
  bmw: ["bmw.com"],
  mercedes: ["mercedes-benz.com"],
  boeing: ["boeing.com"],
  pfizer: ["pfizer.com"],
  costco: ["costco.com"],
  homedepot: ["homedepot.com"],
  ikea: ["ikea.com"],
  unilever: ["unilever.com"],
  nestle: ["nestle.com"],
  bp: ["bp.com"],
  exxonmobil: ["exxonmobil.com"],
  gumroad: ["gumroad.com"],
  gumroadsupport: ["gumroad.com"],
};
const BRAND_AFFIXES = [
  "official",
  "support",
  "help",
  "care",
  "store",
  "shop",
  "inc",
  "corp",
  "hq",
  "usa",
  "uk",
  "us",
  "global",
  "team",
  "login",
  "secure",
  "service",
];
export const BLOCKED_USERNAME_MESSAGE =
  "isn't available. If you represent this company, email support@gumroad.com and we'll set up your account.";

function brandDomains(name: string): string[] | null {
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (name === brand) return domains;
    if (!name.startsWith(brand) && !name.endsWith(brand)) continue;
    const prefixed = name.startsWith(brand) ? name.slice(brand.length) : name;
    let rest = prefixed === name ? (name.endsWith(brand) ? name.slice(0, -brand.length) : name) : prefixed;
    if (rest.startsWith("the")) rest = rest.slice(3);
    if (rest.startsWith("official")) rest = rest.slice(8);
    if (rest === "" || BRAND_AFFIXES.includes(rest) || (brand.length >= 3 && /^\d{1,4}$/u.test(rest))) return domains;
  }
  return null;
}

export function isBlockedUsername(username: unknown, email: string | null | undefined): boolean {
  const name = String(username ?? "").toLowerCase();
  if (isBlank(name)) return false;
  if (GAMBLING_PATTERN.test(name)) return true;
  const domains = brandDomains(name);
  if (domains === null) return false;
  const domain = String(email ?? "")
    .toLowerCase()
    .split("@")[1];
  if (isBlank(domain)) return true;
  return !domains.some((allowed) => domain === allowed || domain!.endsWith(`.${allowed}`));
}

// ---------------------------------------------------------------------------------------------
// json_data (JsonData concern)

// JsonData, shared with the other models that include it.
export function jsonData(record: UserRecord): RubyHash {
  return sharedJsonData(record);
}

export function jsonDataForAttr(record: UserRecord, key: string, fallback: YamlValue = null): YamlValue {
  return sharedJsonDataForAttr(record, key, fallback);
}

export function setJsonDataForAttr(record: UserRecord, key: string, value: YamlValue): void {
  sharedSetJsonDataForAttr(record, key, value);
}

const payoutFrequency = (record: UserRecord) => jsonDataForAttr(record, "payout_frequency", PAYOUT_FREQUENCIES.WEEKLY);
const customFeePerThousand = (record: UserRecord) => jsonDataForAttr(record, "custom_fee_per_thousand");
export const tiktokPixelId = (record: UserRecord) => jsonDataForAttr(record, "tiktok_pixel_id");
export const payoutsPausedBy = (record: UserRecord) => jsonDataForAttr(record, "payouts_paused_by");

// ---------------------------------------------------------------------------------------------
// Instance methods

export const isFlagSet = (record: UserRecord, flag: UserFlag) => UserFlags.isSet(record.get("flags"), flag);

export function setFlag(record: UserRecord, flag: UserFlag, enabled: boolean): void {
  record.set("flags", UserFlags.set(record.get("flags"), flag, enabled));
}

// User#username: the external id stands in for a seller without one.
export function username(record: UserRecord): string | null {
  const raw = record.get("username");
  return isBlank(raw) ? record.get("external_id") : raw;
}

export const nameOrUsername = (record: UserRecord) =>
  isBlank(record.get("name")) ? username(record) : record.get("name");
export const formEmail = (record: UserRecord) =>
  isBlank(record.get("unconfirmed_email"))
    ? isBlank(record.get("email"))
      ? null
      : record.get("email")
    : record.get("unconfirmed_email");
export const isConfirmed = (record: UserRecord) => record.get("confirmed_at") != null;
export const isDeleted = (record: UserRecord) => record.get("deleted_at") != null;
export const isSuspended = (record: UserRecord) =>
  (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(record.get("user_risk_state"));
export const isFlagged = (record: UserRecord) =>
  (RISK_STATES.FLAGGED as readonly (string | null)[]).includes(record.get("user_risk_state"));
export const isCompliant = (record: UserRecord) => record.get("user_risk_state") === "compliant";
export const isOnProbation = (record: UserRecord) => record.get("user_risk_state") === "on_probation";
export const isAccountActive = (record: UserRecord) => !isDeleted(record) && !isSuspended(record);
export const isPayoutsPaused = (record: UserRecord) =>
  isFlagSet(record, "payouts_paused_internally") || isFlagSet(record, "payouts_paused_by_user");
export const maxProductPrice = (record: UserRecord) =>
  record.get("verified") ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
export const isNameInvalidForEmailDelivery = (record: UserRecord) =>
  !isBlank(record.get("name")) && INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX.test(record.get("name")!);

// Subdomain.from_username(username)
export function subdomainFromUsername(
  name: string | null | undefined,
  rootDomain = domainConfig().rootDomain,
): string | null {
  if (isBlank(name)) return null;
  return `${name!.replaceAll("_", "-")}.${rootDomain}`;
}

export const subdomain = (record: UserRecord) => subdomainFromUsername(username(record));

export function subdomainWithProtocol(record: UserRecord): string | null {
  const host = subdomain(record);
  return host ? `${domainConfig().protocol}://${host}` : null;
}

// User#email_domain (Mail::Address#domain of the email).
export function emailDomain(record: UserRecord): string | null {
  const email = record.get("email");
  if (isBlank(email)) return null;
  const domain = mailAddressDomain(email!);
  if (domain === "parse_error") throw new Error(`Mail::Field::ParseError: ${email}`);
  return domain;
}

// User::MoneyBalance#unpaid_balance_cents: balances.unpaid.sum(:amount_cents).
export async function unpaidBalanceCents(record: UserRecord, tx: Pick<Tx, "$queryRaw">): Promise<bigint> {
  const [row] = await tx.$queryRaw<{ sum: bigint | number | Prisma.Decimal | null }[]>(
    Prisma.sql`SELECT SUM(\`balances\`.\`amount_cents\`) AS sum FROM \`balances\` WHERE \`balances\`.\`user_id\` = ${record.get("id")} AND \`balances\`.\`state\` = 'unpaid'`,
  );
  return row?.sum == null ? 0n : BigInt(row.sum.toString());
}

// ---------------------------------------------------------------------------------------------
// Associations the save callbacks load. They stay on the instance (@association_cache) until reload.

type Cached = { foreignKey: unknown; row: unknown };

function associations(record: UserRecord): Map<string, Cached> {
  let entries = record.ivars[ASSOCIATION_CACHE] as Map<string, Cached> | undefined;
  if (!entries) {
    entries = new Map();
    record.ivars[ASSOCIATION_CACHE] = entries;
  }
  return entries;
}

// User#seller_profile: `super || build_seller_profile`. The built profile stays on the instance,
// so the next save of this user inserts it (has_one autosave).
export async function sellerProfile(record: UserRecord): Promise<SellerProfileRecord> {
  const cache = associations(record);
  const cached = cache.get("seller_profile");
  if (cached?.row) return cached.row as SellerProfileRecord;
  const profile =
    (record.newRecord ? null : await findSellerProfile(record.get("id"))) ?? buildSellerProfile(record.get("id"));
  cache.set("seller_profile", { foreignKey: record.get("id"), row: profile });
  return profile;
}

// `association(:seller_profile).target = profile`, as User#with_locked_seller_profile does: later callbacks read this instance's saved changes.
export function setSellerProfileTarget(record: UserRecord, profile: SellerProfileRecord): void {
  associations(record).set("seller_profile", { foreignKey: record.get("id"), row: profile });
}

const PROFILE_PREVIEW_PROPERTIES = ["font", "background_color", "highlight_color"];

async function sellerProfileStyleSaved(record: UserRecord): Promise<boolean> {
  const saved = (await sellerProfile(record)).savedChanges;
  return PROFILE_PREVIEW_PROPERTIES.some((k) => k in saved);
}

// has_one_attached :avatar: `avatar.attached?` loads the attachment once per instance.
async function loadAvatarAttachment(record: UserRecord): Promise<void> {
  const cache = associations(record);
  if (cache.has("avatar_attachment") || record.newRecord) return;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_id")} = ${record.get("id")} AND ${column("active_storage_attachments", "record_type")} = ${"User"} AND ${column("active_storage_attachments", "name")} = ${"avatar"} LIMIT 1`,
  );
  cache.set("avatar_attachment", { foreignKey: record.get("id"), row: row ?? null });
}

// An avatar assigned to a user that is saved later (`avatar.attach` on a new or changed record): its blob row is already written, and the
// attachment row, the upload and the analysis job follow the user's save.
export type PendingAvatar = { contentType: string; save: (record: UserRecord, now: () => Date) => Promise<void> };
const ALLOWED_AVATAR_EXTENSIONS = ["png", "jpg", "jpeg"];

// validate :avatar_is_valid for a newly attached avatar. The size limit is checked by the caller; the dimension check cannot fail because
// the blob is not in the bucket yet (ActiveStorage::FileNotFoundError is rescued).
async function avatarIsValid(record: UserRecord): Promise<void> {
  await loadAvatarAttachment(record);
  const pending = record.ivars.pending_avatar as PendingAvatar | undefined;
  if (pending === undefined) return;
  if (!ALLOWED_AVATAR_EXTENSIONS.some((extension) => pending.contentType.includes(extension)))
    record.errors.add(
      "base",
      `Please upload a profile picture with one of the following extensions: ${ALLOWED_AVATAR_EXTENSIONS.join(", ")}.`,
    );
}

// autosave_associated_records_for_seller_profile (save_has_one_association): only a loaded
// profile that is new or points at another user is saved, with validation, and a failed save
// does not roll the user back.
const AUTOSAVE_SELLER_PROFILE: Callback<User> = {
  name: "autosave_associated_records_for_seller_profile",
  async run(record, ctx) {
    const profile = associations(record).get("seller_profile")?.row as SellerProfileRecord | undefined;
    if (!profile || profile.destroyed) return;
    const key = record.get("id");
    if (!profile.newRecord && !profile.attributeChanged("seller_id")) return;
    if (profile.get("seller_id") !== key) profile.set("seller_id", key);
    await SellerProfiles.save(profile, { now: ctx.now });
  },
};

// ---------------------------------------------------------------------------------------------
// Devise

// User::DeviseInternal#confirmation_required? overrides Devise's.
const emailRequired = (record: UserRecord) => isBlank(record.get("provider"));
const confirmationRequired = (record: UserRecord) =>
  emailRequired(record) && !isConfirmed(record) && !isBlank(record.get("email"));
// Devise::Models::Confirmable#send_confirmation_notification?
const sendConfirmationNotification = (record: UserRecord) =>
  confirmationRequired(record) && !record.ivars.skip_confirmation_notification && !isBlank(record.get("email"));
const reconfirmationRequired = (record: UserRecord) =>
  Boolean(record.ivars.reconfirmation_required) &&
  (!isBlank(record.get("email")) || !isBlank(record.get("unconfirmed_email")));

// Devise's `password=`: the plaintext lives on the instance only.
export async function setPassword(
  record: UserRecord,
  password: string | null,
  confirmation?: string | null,
): Promise<void> {
  const { digestPassword } = await import("../auth/devise-password.ts");
  record.ivars.password = password;
  if (confirmation !== undefined) record.ivars.password_confirmation = confirmation;
  if (!isBlank(password)) record.set("encrypted_password", await digestPassword(password!));
}

const passwordRequired = (record: UserRecord) =>
  !record.persisted || record.ivars.password != null || record.ivars.password_confirmation != null;

// Datetime(0) columns: Rails truncates the assigned Time to whole seconds.
const toSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

// Confirmable#generate_confirmation_token. confirm_within is not configured, so a token never expires.
function generateConfirmationToken(record: UserRecord): void {
  if (record.get("confirmation_token")) {
    record.ivars.raw_confirmation_token = record.get("confirmation_token");
    return;
  }
  const token = collaborators.friendlyToken();
  record.set("confirmation_token", token);
  record.ivars.raw_confirmation_token = token;
  record.set("confirmation_sent_at", toSeconds(collaborators.now()));
}

// ---------------------------------------------------------------------------------------------
// Validations

async function pwnedPassword(record: UserRecord): Promise<void> {
  if (!record.attributeChanged("encrypted_password")) return;
  let count = 0;
  try {
    count = await collaborators.pwnedCount(String(record.ivars.password ?? ""));
  } catch {
    return;
  }
  // min_password_matches is 1 and min_password_matches_warn is unset.
  if (count >= 1)
    record.errors.add("password", "has previously appeared in a data breach as per haveibeenpwned.com", { count });
}

async function activePlatformBlockExists(tx: Tx, objectType: string, value: string | null): Promise<boolean> {
  if (isBlank(value)) return false;
  const now = toSeconds(collaborators.now());
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT \`platform_blocks\`.* FROM \`platform_blocks\` WHERE \`platform_blocks\`.\`blocked_at\` IS NOT NULL AND (expires_at IS NULL OR expires_at > ${now}) AND \`platform_blocks\`.\`object_value\` = ${value} AND \`platform_blocks\`.\`object_type\` = ${objectType} ORDER BY \`platform_blocks\`.\`id\` ASC LIMIT 1`,
  );
  return rows.length > 0;
}

// EachValidator with `allow_nil`/`allow_blank`/`if`, for the custom validators below.
function each(
  name: string,
  attribute: keyof User & string,
  opts: { allowBlank?: boolean; if?: (r: UserRecord) => boolean; unless?: (r: UserRecord) => boolean; on?: "create" },
  check: (record: UserRecord, value: unknown, ctx: CallbackContext) => unknown,
): Callback<User> {
  return {
    name,
    on: opts.on,
    if: opts.if,
    unless: opts.unless,
    run: async (record, ctx) => {
      const value = record.get(attribute);
      if (opts.allowBlank && isBlank(value)) return;
      await check(record, value, ctx);
    },
  };
}

const usernameChanged = (r: UserRecord) => r.attributeChanged("username");

// validates :custom_fee_per_thousand, numericality: { only_integer: true, 0..1000 }, allow_nil: true.
// The value is a json_data entry, so it can be a String or Float, which ActiveModel parses itself
// (INTEGER_REGEX, HEXADECIMAL_REGEX, then Kernel.Float).
const KERNEL_FLOAT =
  /^[\t\n\v\f\r ]*[+-]?(?=\.?\d)(\d+(_\d+)*)?(\.(\d+(_\d+)*)?)?([eE][+-]?\d+(_\d+)*)?[\t\n\v\f\r ]*$/u;

function customFeeValidation(): Callback<User> {
  return {
    name: "validates :custom_fee_per_thousand, numericality",
    run(record) {
      const value = customFeePerThousand(record);
      if (value == null) return;
      const isInteger =
        typeof value === "bigint" ||
        (typeof value === "number" && Number.isInteger(value)) ||
        (typeof value === "string" && /^[+-]?\d+$/u.test(value));
      const isNumber =
        isInteger ||
        isRubyFloat(value) ||
        (typeof value === "string" && !/^[+-]?0[xX]/u.test(value) && KERNEL_FLOAT.test(value));
      if (!isNumber) return record.errors.add("custom_fee_per_thousand", "not_a_number", { value });
      if (!isInteger) return record.errors.add("custom_fee_per_thousand", "not_an_integer", { value });
      const n = Number(value);
      if (n < 0) record.errors.add("custom_fee_per_thousand", "greater_than_or_equal_to", { count: 0, value });
      if (n > 1000) record.errors.add("custom_fee_per_thousand", "less_than_or_equal_to", { count: 1000, value });
    },
  };
}

function inclusionWithValueMessage(
  attribute: "timezone" | "currency_type",
  values: readonly (string | null)[],
  template: string,
): Callback<User> {
  return {
    name: `validates :${attribute}, inclusion`,
    run(record) {
      const value = record.get(attribute);
      if (!values.includes(value))
        record.errors.add(attribute, "inclusion", {
          value,
          message: template.replace("%{value}", value == null ? "" : String(value)),
        });
    },
  };
}

const VALIDATIONS: Callback<User>[] = [
  // Devise pwned_password (devise is declared first in user.rb).
  { name: "validate :not_pwned_password", run: pwnedPassword },
  // validates :username, ... allow_nil: true, if: :username_changed? (read_attribute_for_validation reads the column).
  validatesUniquenessOf<User>("users", ["username"], { case_sensitive: true, allow_nil: true, if: usernameChanged }),
  validatesLengthOf<User>(["username"], { minimum: 3, maximum: 20, allow_nil: true, if: usernameChanged }),
  validatesExclusionOf<User>(["username"], { in: DENYLIST, allow_nil: true, if: usernameChanged }),
  each(
    "validates :username, blocked_username",
    "username",
    { if: (r) => usernameChanged(r) && r.get("username") != null },
    (record, value) => {
      // BlockedUsernameValidator.proven_email: only an address the account has confirmed counts.
      const email = !isConfirmed(record)
        ? null
        : record.persisted && record.attributeChanged("email")
          ? record.attributeInDatabase("email")
          : record.get("email");
      if (isBlockedUsername(value, email)) record.errors.add("username", BLOCKED_USERNAME_MESSAGE);
    },
  ),
  validatesFormatOf<User>(["username"], {
    with: /^[a-z0-9]*[a-z][a-z0-9]*$/u,
    message: "has to contain at least one letter and may only contain lower case letters and numbers.",
    allow_nil: true,
    if: usernameChanged,
  }),
  validatesLengthOf<User>(["name"], {
    maximum: MAX_LENGTH_NAME,
    too_long: "Your name is too long. Please try again with a shorter one.",
  }),
  validatesFormatOf<User>(["name"], {
    without: INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX,
    message:
      "cannot contain colons (:) as it causes email delivery problems. Please remove any colons from your name and try again.",
    if: (r) => r.attributeChanged("name"),
  }),
  validatesLengthOf<User>(["facebook_meta_tag"], { maximum: MAX_LENGTH_FACEBOOK_META_TAG }),
  validatesNumericalityOf<User>(["purchasing_power_parity_limit"], {
    allow_nil: true,
    greater_than_or_equal_to: 1,
    less_than_or_equal_to: 100,
  }),
  each("validates_presence_of :email", "email", { if: emailRequired }, (record, value) => {
    if (isBlank(value)) record.errors.add("email", "blank");
  }),
  {
    name: "validate :email_almost_unique",
    async run(record, { tx }) {
      const email = record.get("email");
      if (!record.attributeChanged("email") || isBlank(email)) return;
      const holders = await tx.$queryRaw<{ deleted_at: Date | null }[]>(
        Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE \`users\`.\`email\` = ${email}`,
      );
      if (holders.length === 0) return;
      record.errors.add(
        "base",
        holders.every((h) => h.deleted_at != null)
          ? DELETED_ACCOUNT_HOLDS_EMAIL_ERROR
          : "An account already exists with this email.",
      );
    },
  },
  each(
    "validates :email, email_format",
    "email",
    { allowBlank: true, if: (r) => r.attributeChanged("email") },
    (record, value) => {
      if (!isValidEmailFormat(value)) record.errors.add("email", "invalid");
    },
  ),
  each("validates :email, disposable_email", "email", { on: "create" }, (record, value) => {
    if (isDisposableEmail(value)) record.errors.add("email", "is from a disposable email provider and cannot be used");
  }),
  validatesFormatOf<User>(["kindle_email"], {
    with: KINDLE_EMAIL_REGEX,
    allow_blank: true,
    if: (r) => r.attributeChanged("kindle_email"),
  }),
  each(
    "validates :support_email, email_format",
    "support_email",
    { allowBlank: true, if: (r) => r.attributeChanged("support_email") },
    (record, value) => {
      if (!isValidEmailFormat(value)) record.errors.add("support_email", "invalid");
    },
  ),
  each(
    "validates :support_email, not_reserved_email_domain",
    "support_email",
    { allowBlank: true, if: (r) => r.attributeChanged("support_email"), unless: (r) => isFlagSet(r, "is_team_member") },
    (record, value) => {
      if (isReservedEmailDomain(value)) record.errors.add("support_email", "is reserved");
    },
  ),
  {
    name: "validate :google_analytics_id_valid",
    run(record) {
      const value = record.get("google_analytics_id");
      if (isBlank(value) || /G-[a-zA-Z0-9]+/u.test(value!)) return;
      record.errors.add("base", "Please enter a valid Google Analytics ID");
    },
  },
  {
    name: "validate :tiktok_pixel_id_valid",
    run(record) {
      const value = tiktokPixelId(record);
      if (isBlank(value) || /^[A-Z0-9]+$/u.test(String(value))) return;
      record.errors.add("base", "Please enter a valid TikTok Pixel ID");
    },
  },
  {
    name: "validate :facebook_pixel_id_valid",
    if: (r) => r.attributeChanged("facebook_pixel_id"),
    run(record) {
      const value = record.get("facebook_pixel_id");
      if (isBlank(value) || /^[1-9][0-9]{0,25}$/u.test(value!)) return;
      record.errors.add("base", "Please enter a valid Facebook Pixel ID");
    },
  },
  { name: "validate :avatar_is_valid", run: avatarIsValid },
  {
    name: "validate :payout_frequency_is_valid",
    run(record) {
      if ((Object.values(PAYOUT_FREQUENCIES) as YamlValue[]).includes(payoutFrequency(record))) return;
      record.errors.add("payout_frequency", "must be daily, weekly, monthly, or quarterly");
    },
  },
  {
    name: "validates_presence_of :password",
    if: passwordRequired,
    run(record) {
      if (isBlank(record.ivars.password)) record.errors.add("password", "blank");
    },
  },
  {
    name: "validates_confirmation_of :password",
    if: passwordRequired,
    run(record) {
      const confirmation = record.ivars.password_confirmation;
      if (confirmation != null && confirmation !== record.ivars.password)
        record.errors.add("password_confirmation", "doesn't match Password", { attribute: "Password" });
    },
  },
  {
    // within: 4...128 is an exclusive range, so the maximum is 127.
    name: "validates_length_of :password",
    run(record) {
      const password = record.ivars.password;
      if (isBlank(password)) return;
      const length = rubyLength(password);
      if (length < 4) record.errors.add("password", "too_short", { count: 4 });
      if (length > 127) record.errors.add("password", "too_long", { count: 127 });
    },
  },
  inclusionWithValueMessage("timezone", TIME_ZONES, "%{value} is not a known time zone."),
  {
    name: "validates :recommendation_type, inclusion",
    run(record) {
      const value = record.get("recommendation_type");
      if (!(RECOMMENDATION_TYPES as (string | null)[]).includes(value))
        record.errors.add("recommendation_type", "inclusion", { value });
    },
  },
  inclusionWithValueMessage("currency_type", CURRENCIES, "%{value} is not a supported currency."),
  customFeeValidation(),
  // validate :json_data reads the column, which turns NULL into {}.
  { name: "validate :json_data", run: (record) => void jsonData(record) },
  { name: "validate :json_data_must_be_hash", run: (record) => void jsonData(record) },
  {
    name: "validate :account_created_email_domain_is_not_blocked",
    on: "create",
    async run(record, { tx }) {
      if (record.errors.on("email").length > 0) return;
      if (await activePlatformBlockExists(tx, "email_domain", emailDomain(record)))
        record.errors.add("base", "blocked_signup", { message: "Something went wrong." });
    },
  },
  {
    name: "validate :account_created_ip_is_not_blocked",
    on: "create",
    async run(record, { tx }) {
      if (await activePlatformBlockExists(tx, "ip_address", record.get("account_created_ip")))
        record.errors.add("base", "blocked_signup", { message: "Something went wrong." });
    },
  },
  {
    name: "validate :email_not_from_suspended_gmail_variant",
    on: "create",
    async run(record) {
      const normalized = normalizeGmailAddress(record.get("email"));
      if (normalized === null || !GMAIL_DOMAINS.includes(normalized.split("@", 2)[1] ?? "")) return;
      if (await collaborators.sismember(GMAIL_ABUSE_REDIS_KEY, normalized))
        record.errors.add("base", "blocked_signup", { message: "Something went wrong." });
    },
  },
  {
    name: "validate :facebook_meta_tag_is_valid",
    run(record) {
      const value = record.get("facebook_meta_tag");
      if (
        isBlank(value) ||
        /^<meta[\t\n\v\f\r ]+name=(["'])facebook-domain-verification(?:\1)[\t\n\v\f\r ]+content=(["'])\w+(?:\2)[\t\n\v\f\r ]*\/>$/u.test(
          value!,
        )
      )
        return;
      record.errors.add("base", "Please enter a valid meta tag");
    },
  },
  each("validates :payment_address, email_format", "payment_address", { allowBlank: true }, (record, value) => {
    if (!isValidEmailFormat(value)) record.errors.add("payment_address", "invalid");
  }),
];

// ---------------------------------------------------------------------------------------------
// Callbacks

const STRIPPED_FIELDS = [
  "name",
  "facebook_meta_tag",
  "google_analytics_id",
  "username",
  "email",
  "support_email",
] as const;

const BEFORE_VALIDATION: Callback<User>[] = [
  {
    name: "stripped_fields :name, :facebook_meta_tag, :google_analytics_id, :username, :email, :support_email",
    run(record) {
      for (const field of STRIPPED_FIELDS) record.set(field, strippedField(record.get(field)));
    },
  },
  {
    name: "before_validation { facebook_pixel_id.strip }",
    run(record) {
      const value = record.get("facebook_pixel_id");
      if (record.attributeChanged("facebook_pixel_id") && !isBlank(value))
        record.set("facebook_pixel_id", rubyStrip(value!));
    },
  },
  {
    name: "before_validation { tiktok_pixel_id.strip }",
    run(record) {
      const value = tiktokPixelId(record);
      if (isBlank(value)) return;
      // json_data keeps a JSON integer as an Integer, which has no #strip.
      if (Number.isInteger(value)) throw new NoMethodError("undefined method 'strip' for an instance of Integer");
      if (typeof value !== "string")
        throw new NotPortedError("strip on a non-string tiktok_pixel_id", "User before_validation");
      setJsonDataForAttr(record, "tiktok_pixel_id", rubyStrip(value));
    },
  },
];

// Devise::Models::Confirmable#postpone_email_change?, without its side effect on
// @bypass_confirmation_postpone (reset by the callback itself).
const postponeEmailChange = (record: UserRecord) =>
  record.attributeChanged("email") &&
  !record.ivars.bypass_confirmation_postpone &&
  !isBlank(record.get("email")) &&
  (!record.ivars.skip_reconfirmation_in_callback || record.attributeInDatabase("email") != null);

const savedChangeToFlag = (record: UserRecord, flag: UserFlag) => {
  const change = record.savedChanges.flags;
  if (!change) return false;
  return UserFlags.isSet(change[0] as bigint, flag) !== UserFlags.isSet(change[1] as bigint, flag);
};

function productSearchChangeList(
  record: UserRecord,
  changed: (attribute: keyof User & string) => boolean,
  flagChanged: (flag: UserFlag) => boolean,
): string[] {
  const riskChange =
    record.savedChanges.user_risk_state ??
    (record.attributeChanged("user_risk_state")
      ? [record.attributeInDatabase("user_risk_state"), record.get("user_risk_state")]
      : null);
  const list: string[] = [];
  if ((riskChange && riskChange.includes("compliant")) || changed("payment_address")) list.push("is_recommendable");
  if (changed("username") || changed("name") || changed("bio") || flagChanged("all_adult_products"))
    list.push("rated_as_adult");
  if (changed("username") || changed("name")) list.push("creator_name");
  return list;
}

// `links.ids`
async function productIds(tx: Pick<Tx, "$queryRaw">, userId: unknown): Promise<bigint[]> {
  const rows = await tx.$queryRaw<{ id: bigint }[]>(
    Prisma.sql`SELECT \`links\`.\`id\` FROM \`links\` WHERE \`links\`.\`user_id\` = ${userId}`,
  );
  return rows.map((r) => BigInt(r.id));
}

// User#clear_products_cache
export async function clearProductsCache(userId: unknown): Promise<void> {
  const ids = await productIds(await connection(), userId);
  try {
    await collaborators.enqueueBulk(
      "InvalidateProductCacheWorker",
      ids.map((id) => [id]),
    );
  } catch (error) {
    if (!isRedisTransportError(error)) throw error;
    notifyError(error, { user_id: userId });
  }
}

async function approvedAffiliateRequestIds(tx: Pick<Tx, "$queryRaw">, email: string): Promise<bigint[]> {
  const rows = await tx.$queryRaw<{ id: bigint }[]>(
    Prisma.sql`SELECT \`affiliate_requests\`.* FROM \`affiliate_requests\` WHERE \`affiliate_requests\`.\`state\` = 'approved' AND \`affiliate_requests\`.\`email\` = ${email}`,
  );
  return rows.map((r) => BigInt(r.id));
}

const makeAffiliateApplies = (record: UserRecord, confirmedAtChanged: boolean) =>
  confirmedAtChanged &&
  isConfirmed(record) &&
  !isFlagSet(record, "pre_signup_affiliate_request_processed") &&
  !isBlank(record.get("email"));

// Fails a save whose after-commit work would reach a collaborator Node does not have yet, before
// anything is written. Not a Ruby callback.
const REFUSE_UNPORTED_SIDE_EFFECTS: Callback<User> = {
  name: "refuse_unported_side_effects",
  async run(record, { tx }) {
    if (
      record.untracked(() => makeAffiliateApplies(record, record.attributeChanged("confirmed_at"))) &&
      isDefault("makeRequestersAffiliates")
    ) {
      if ((await approvedAffiliateRequestIds(tx, record.get("email")!)).length > 0) {
        throw new NotPortedError(
          "AffiliateRequest#make_requester_an_affiliate!",
          "app/models/user.rb:1918 make_affiliate_of_the_matching_approved_affiliate_requests",
        );
      }
    }
  },
};

const MERGE_JSON_DATA = mergeJsonDataWithCurrentRow<User>("users");

const enableFlags = (name: string, flags: UserFlag[], unless?: Callback<User>["unless"]): Callback<User> => ({
  name,
  unless,
  run: (record) => {
    for (const flag of flags) setFlag(record, flag, true);
  },
});

const isRedisTransportError = (error: unknown) => {
  const e = error as { name?: string; code?: string; message?: string } | null;
  return Boolean(
    e &&
      (e.name === "MaxRetriesPerRequestError" ||
        ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENOTFOUND"].includes(e.code ?? "") ||
        e.message === "Connection is closed."),
  );
};

// AfterCommitEverywhere.after_commit: runs once the outermost transaction commits, after the
// records already in it.
function afterCommitEverywhere(fn: () => Promise<unknown>): Promise<unknown> | void {
  if (!currentTransaction()) return fn();
  const key = {};
  const participant = participate(key, "update", () => ({
    commit: async () => void (await fn()),
    rollback: async () => undefined,
    restore: () => undefined,
  }));
  participant.triggered = true;
}

const paperTrail = hasPaperTrail<User>("User", {
  itemType: "User",
  skip: [
    "encrypted_password",
    "reset_password_token",
    "confirmation_token",
    "otp_secret_key",
    "twitter_oauth_token",
    "twitter_oauth_secret",
    "facebook_access_token",
  ],
});

const FLAGS_TO_ENABLE_BY_DEFAULT: UserFlag[] = [
  "enable_payment_email",
  "enable_payment_push_notification",
  "enable_free_downloads_email",
  "enable_free_downloads_push_notification",
];

const base = defineModel<User>({
  rubyClass: "User",
  prismaModel: "User",
  delegate: (tx) => tx.user as never,
  beforeValidation: BEFORE_VALIDATION,
  validations: VALIDATIONS,
  beforeSave: [
    REFUSE_UNPORTED_SIDE_EFFECTS,
    MERGE_JSON_DATA,
    { name: "set_avatar_changed", run: (record) => void (record.ivars.avatar_changed = false) },
    {
      name: "append_http",
      run: (record) => {
        const endpoint = record.get("notification_endpoint");
        if (!isBlank(endpoint) && !endpoint!.includes("http"))
          record.set("notification_endpoint", `http://${endpoint}`);
      },
    },
    {
      name: "save_external_id",
      async run(record, { tx }) {
        if (!isBlank(record.get("external_id"))) return;
        for (;;) {
          const candidate = collaborators.randomExternalId();
          const rows = await tx.$queryRaw<unknown[]>(
            Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE \`users\`.\`external_id\` = ${candidate} LIMIT 1`,
          );
          if (rows.length === 0) {
            record.set("external_id", candidate);
            return;
          }
        }
      },
    },
  ],
  beforeCreate: [
    { name: "devise generate_confirmation_token", if: confirmationRequired, run: generateConfirmationToken },
    {
      name: "has_one_time_password otp_regenerate_secret",
      if: (r) => !r.get("otp_secret_key"),
      run: (r) => r.set("otp_secret_key", collaborators.otpSecret()),
    },
    enableFlags("init_default_notification_settings", FLAGS_TO_ENABLE_BY_DEFAULT),
    enableFlags("enable_two_factor_authentication", ["two_factor_authentication_enabled"], (r) =>
      Boolean(r.ivars.skip_enabling_two_factor_authentication),
    ),
    enableFlags("enable_tipping", ["tipping_enabled"]),
    enableFlags("enable_discover_boost", ["discover_boost_enabled"]),
    // New accounts only: existing creators keep the standalone product page until lift is measured.
    enableFlags("enable_product_page_storefront", ["product_page_storefront_enabled"]),
    enableFlags("set_refund_fee_notice_shown", ["refund_fee_notice_shown"]),
    {
      name: "set_refund_policy_enabled",
      run: async (record) =>
        setFlag(
          record,
          "refund_policy_enabled",
          await collaborators.isFeatureEnabled("seller_refund_policy_new_users_enabled"),
        ),
    },
  ],
  beforeUpdate: [
    {
      // Recoverable: authentication_keys is [:login], a virtual attribute, so only a password change clears it.
      name: "devise clear_reset_password_token",
      if: (r) => r.attributeChanged("encrypted_password"),
      run(record) {
        record.set("reset_password_token", null);
        record.set("reset_password_sent_at", null);
      },
    },
    {
      name: "devise postpone_email_change_until_confirmation_and_regenerate_confirmation_token",
      if: (r) => {
        const postpone = postponeEmailChange(r);
        r.ivars.bypass_confirmation_postpone = false;
        return postpone;
      },
      run(record) {
        record.ivars.reconfirmation_required = true;
        record.set("unconfirmed_email", record.get("email"));
        record.set("email", record.attributeInDatabase("email"));
        record.set("confirmation_token", null);
        generateConfirmationToken(record);
      },
    },
  ],
  afterCreate: [
    { name: "previously_new_record", run: (r) => void (r.ivars.previously_new_record = true) },
    {
      name: "devise skip_reconfirmation_in_callback!",
      if: sendConfirmationNotification,
      run: (r) => void (r.ivars.skip_reconfirmation_in_callback = true),
    },
    ...paperTrail.afterCreate,
    {
      // has_many :tos_agreements, autosaved for a new parent: `user.tos_agreements.build(ip:)` before the save.
      name: "autosave_associated_records_for_tos_agreements",
      async run(record) {
        const ips = record.ivars.new_tos_agreement_ips as (string | null)[] | undefined;
        if (!ips) return;
        const { TosAgreements } = await import("./tos-agreement.ts");
        for (const ip of ips) await TosAgreements.createBang({ user_id: Number(record.get("id")), ip });
      },
    },
    AUTOSAVE_SELLER_PROFILE,
    { name: "create_global_affiliate!", run: (r, ctx) => collaborators.createGlobalAffiliate(r, ctx) },
    { name: "create_refund_policy!", run: (r, ctx) => collaborators.createRefundPolicy(r, ctx) },
  ],
  afterUpdate: [
    { name: "previously_new_record", run: (r) => void (r.ivars.previously_new_record = false) },
    {
      name: "devise send_email_changed_notification",
      if: reconfirmationRequired,
      run: (r) => collaborators.sendDeviseNotification(r, "email_changed", { to: r.attributeBeforeLastSave("email") }),
    },
    ...paperTrail.afterUpdate,
    AUTOSAVE_SELLER_PROFILE,
    {
      name: "clear_products_cache",
      async run(record, { tx }) {
        if (
          !(
            LINK_PROPERTIES.some((p) => p in record.savedChanges) ||
            tiktokPixelIdChangedInJsonData(record) ||
            (await sellerProfileStyleSaved(record))
          )
        )
          return;
        const ids = await productIds(tx, record.get("id"));
        try {
          await collaborators.enqueueBulk(
            "InvalidateProductCacheWorker",
            ids.map((id) => [id]),
          );
        } catch (error) {
          if (!isRedisTransportError(error)) throw error;
          notifyError(error, { user_id: record.get("id") });
        }
      },
    },
    {
      name: "update_audience_members_affiliates",
      async run(record, ctx) {
        if (!record.savedChangeTo("email")) return;
        const rows = await ctx.tx.$queryRaw<{ seller_id: bigint }[]>(
          Prisma.sql`SELECT DISTINCT \`affiliates\`.\`seller_id\` FROM \`affiliates\` WHERE \`affiliates\`.\`type\` = 'DirectAffiliate' AND \`affiliates\`.\`deleted_at\` IS NULL AND \`affiliates\`.\`affiliate_user_id\` = ${record.get("id")}`,
        );
        if (rows.length > 0)
          await collaborators.updateAudienceMembersAffiliates(
            record,
            rows.map((r) => BigInt(r.seller_id)),
            ctx,
          );
      },
    },
    {
      name: "update_product_search_index!",
      async run(record) {
        const changeList = productSearchChangeList(
          record,
          (a) => record.savedChangeTo(a),
          (f) => savedChangeToFlag(record, f),
        );
        if (changeList.length === 0) return;
        // products.find_each; a throw here rolls the save back.
        await findInBatches<{ id: bigint }>(
          "links",
          Prisma.sql`${column("links", "user_id")} = ${record.get("id")}`,
          1000,
          async (rows) => {
            await collaborators.enqueueProductIndexUpdates(
              record,
              rows.map((r) => BigInt(r.id)),
              changeList,
            );
          },
        );
      },
    },
    {
      name: "update_alive_cart_email",
      if: (r) => r.savedChangeTo("email"),
      async run(record, ctx) {
        const [cart] = await ctx.tx.$queryRaw<{ id: bigint }[]>(
          Prisma.sql`SELECT \`carts\`.* FROM \`carts\` WHERE \`carts\`.\`deleted_at\` IS NULL AND \`carts\`.\`user_id\` = ${record.get("id")} LIMIT 1`,
        );
        if (cart) await collaborators.updateAliveCartEmail(record, BigInt(cart.id), ctx);
      },
    },
  ],
  afterSave: [
    // ensure_json_data_fits_column only checks varchar columns; users.json_data is mediumtext.
    { name: "ensure_json_data_fits_column", run: () => undefined },
    {
      name: "autosave_associated_records_for_avatar_attachment",
      async run(record, { now }) {
        const pending = record.ivars.pending_avatar as PendingAvatar | undefined;
        if (pending === undefined) return;
        delete record.ivars.pending_avatar;
        await pending.save(record, now ?? (() => new Date()));
      },
    },
    {
      name: "create_updated_stripe_apple_pay_domain",
      if: (r) => r.savedChangeTo("username"),
      async run(record) {
        if (subdomain(record)) await collaborators.enqueue("CreateStripeApplePayDomainWorker", [record.get("id")]);
      },
    },
    {
      name: "delete_old_stripe_apple_pay_domain",
      if: (r) => r.savedChangeTo("username"),
      async run(record) {
        const old = record.savedChanges.username![0] as string | null;
        if (isBlank(old)) return;
        await collaborators.enqueue("DeleteStripeApplePayDomainWorker", [record.get("id"), subdomainFromUsername(old)]);
      },
    },
    {
      name: "enqueue_stripe_business_profile_sync",
      if: (r) => r.savedChangeTo("username"),
      async run(record) {
        if (isBlank(record.savedChanges.username![0])) return;
        await afterCommitEverywhere(() => collaborators.enqueue("SyncStripeBusinessProfileUrlJob", [record.get("id")]));
      },
    },
    {
      name: "fence_newsletter_cutover",
      if: newsletterEligibilityChanged,
      run: (record, { tx }) =>
        fenceNewsletterCutover(tx, [record.attributeBeforeLastSave("email"), record.get("email")]),
    },
  ],
  // Declaration order; the runtime runs after_commit callbacks in reverse.
  afterCommit: [
    {
      name: "devise send_on_create_confirmation_instructions",
      on: "create",
      if: sendConfirmationNotification,
      run: (r) =>
        collaborators.sendDeviseNotification(r, "confirmation_instructions", { token: r.ivars.raw_confirmation_token }),
    },
    {
      name: "devise send_reconfirmation_instructions",
      on: "update",
      if: reconfirmationRequired,
      run: (r) =>
        collaborators.sendDeviseNotification(r, "confirmation_instructions", {
          token: r.ivars.raw_confirmation_token,
          to: r.get("unconfirmed_email"),
        }),
    },
    // send_pending_devise_notifications: Devise only queues a notification while the record is new or
    // dirty, and every Node caller runs after the save, so nothing is ever pending.
    { name: "send_pending_devise_notifications", run: () => undefined },
    {
      name: "reindex_subscription_current_email",
      on: "update",
      if: (r) => r.savedChangeTo("email") || r.savedChangeTo("unconfirmed_email"),
      run: (r) => collaborators.enqueue("ReindexSubscriptionCurrentEmailWorker", [r.get("id")], { delaySeconds: 10 }),
    },
    { name: "reset_avatar_changed", run: (r) => void (r.ivars.avatar_changed = false) },
    {
      name: "enqueue_generate_username_job",
      on: "create",
      async run(record) {
        if (!isBlank(record.get("username"))) return;
        await collaborators.enqueue("GenerateUsernameJob", [record.get("id")]);
      },
    },
    {
      name: "move_purchases_to_new_email",
      on: "update",
      if: (r) => r.savedChangeTo("email"),
      async run(record) {
        if (!isBlank(record.get("unconfirmed_email"))) return;
        const db = await collaborators.readDb();
        const rows = await db.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM \`purchases\` WHERE \`purchases\`.\`purchaser_id\` = ${record.get("id")} LIMIT 1`,
        );
        if (rows.length > 0)
          await collaborators.enqueue("UpdatePurchaseEmailToMatchAccountWorker", [record.get("id")], {
            delaySeconds: 10,
          });
      },
    },
    {
      name: "make_affiliate_of_the_matching_approved_affiliate_requests",
      on: ["create", "update"],
      if: (r) => r.savedChangeTo("confirmed_at") && isConfirmed(r),
      async run(record) {
        if (!makeAffiliateApplies(record, true)) return;
        const ids = await approvedAffiliateRequestIds(await collaborators.readDb(), record.get("email")!);
        if (ids.length > 0) await collaborators.makeRequestersAffiliates(record, ids);
        // Confirmation can commit a record that fails validation, so don't re-validate here.
        setFlag(record, "pre_signup_affiliate_request_processed", true);
        await Users.saveBang(record, { validate: false });
      },
    },
    {
      name: "generate_subscribe_preview",
      on: ["create", "update"],
      async run(record) {
        // should_subscribe_preview_be_regenerated?
        const regenerate =
          Boolean(record.ivars.previously_new_record) ||
          ["name", "username", "bio"].some((k) => k in record.savedChanges) ||
          (await sellerProfileStyleSaved(record)) ||
          Boolean(record.ivars.avatar_changed);
        if (!regenerate) return;
        try {
          await collaborators.enqueue("GenerateSubscribePreviewJob", [record.get("id")]);
        } catch (error) {
          if (!isRedisTransportError(error)) throw error;
          console.warn(`Subscribe preview enqueue skipped for user ${record.get("id")}: ${(error as Error).name}`);
        }
      },
    },
  ],
});

function tiktokPixelIdChangedInJsonData(record: UserRecord): boolean {
  const change = record.savedChanges.json_data;
  if (!change) return false;
  const read = (text: unknown) => {
    const parsed = text == null ? null : toHash(rubyJsonParse(String(text)));
    const value = parsed ? jsonGet(parsed, "tiktok_pixel_id") : undefined;
    return value === undefined ? "null" : rubyJsonGenerate(value);
  };
  return read(change[0]) !== read(change[1]);
}

// User#newsletter_eligibility_changed?
function newsletterEligibilityChanged(record: UserRecord): boolean {
  if (record.ivars.previously_new_record) return record.get("confirmed_at") != null;
  return (
    record.savedChangeTo("email") ||
    record.savedChangeTo("confirmed_at") ||
    record.savedChangeTo("deleted_at") ||
    record.savedChangeTo("user_risk_state") ||
    savedChangeToFlag(record, "announcement_notification_enabled")
  );
}

// FeatureAnnouncementNewsletterCutover.fence_account_change, which reads in
// `connected_to(role: :writing) { uncached { ... } }`.
export function fenceNewsletterCutover(tx: Tx, emails: (string | null)[]): Promise<void> {
  return connectedTo("writing", () => uncached(() => fenceAccountChange(tx, emails)));
}

async function fenceAccountChange(tx: Tx, emails: (string | null)[]): Promise<void> {
  const cutovers = await tx.$queryRaw<{ seller_id: bigint }[]>(
    Prisma.sql`SELECT \`feature_announcement_newsletter_cutovers\`.\`seller_id\` FROM \`feature_announcement_newsletter_cutovers\` WHERE \`feature_announcement_newsletter_cutovers\`.\`state\` != 'retired'`,
  );
  const sellerIds = cutovers.map((r) => BigInt(r.seller_id));
  const [official] = await tx.$queryRaw<{ id: bigint }[]>(
    Prisma.sql`SELECT \`users\`.\`id\` FROM \`users\` WHERE \`users\`.\`external_id\` = ${NEWSLETTER_SELLER_EXTERNAL_ID} LIMIT 1`,
  );
  if (official) {
    const officialId = BigInt(official.id);
    const retired = await tx.$queryRaw<unknown[]>(
      Prisma.sql`SELECT 1 AS one FROM \`feature_announcement_newsletter_cutovers\` WHERE \`feature_announcement_newsletter_cutovers\`.\`seller_id\` = ${officialId} AND \`feature_announcement_newsletter_cutovers\`.\`state\` = 'retired' LIMIT 1`,
    );
    if (retired.length === 0 && !sellerIds.includes(officialId)) sellerIds.push(officialId);
  }
  if (sellerIds.length === 0) return;
  const addresses = [...new Set(emails.filter((e): e is string => !isBlank(e)))];
  const followerRows =
    addresses.length === 0
      ? []
      : await tx.$queryRaw<{ id: bigint }[]>(
          Prisma.sql`SELECT \`followers\`.\`id\` FROM \`followers\` WHERE \`followers\`.\`followed_id\` IN (${Prisma.join(sellerIds)}) AND \`followers\`.\`email\` IN (${Prisma.join(addresses)}) FOR UPDATE`,
        );
  if (followerRows.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT \`feature_announcement_newsletter_cutovers\`.\`state\` FROM \`feature_announcement_newsletter_cutovers\` WHERE \`feature_announcement_newsletter_cutovers\`.\`seller_id\` IN (${Prisma.join(sellerIds)}) ORDER BY \`feature_announcement_newsletter_cutovers\`.\`seller_id\` ASC FOR SHARE`,
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE \`followers\` SET \`followers\`.\`updated_at\` = ${toSeconds(collaborators.now())} WHERE \`followers\`.\`id\` IN (${Prisma.join(followerRows.map((r) => BigInt(r.id)))})`,
  );
}

// `attribute :recommendation_type, default:` and the user_risk_state machine's initial state are
// set on initialize, so a new record carries them as changes (which paper_trail records).
function build(attributes: Partial<User> = {}): UserRecord {
  const record = base.build();
  record.set("recommendation_type", "own_products");
  if (record.get("user_risk_state") == null) record.set("user_risk_state", "not_reviewed");
  record.assign(attributes);
  if (record.get("user_risk_state") == null) record.set("user_risk_state", "not_reviewed");
  return record;
}

export const Users = {
  ...base,
  build,
  async create(attributes: Partial<User>, options?: SaveOptions) {
    const record = build(attributes);
    await base.save(record, options);
    return record;
  },
  async createBang(attributes: Partial<User>, options?: SaveOptions) {
    return base.saveBang(build(attributes), options);
  },
};

export const UserDeletable = deletable(base);

// User.find_by(id:)
export async function findUser(id: unknown): Promise<UserRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${id} LIMIT 1`,
  );
  return row ? Users.load(castRow<User>("User", row)) : null;
}

// User.find(id)
export async function findUserBang(id: unknown): Promise<UserRecord> {
  const user = await findUser(id);
  if (!user) throw new RecordNotFound(`Couldn't find User with 'id'=${String(id)}`);
  return user;
}

// User::LowBalanceFraudCheck#enable_refunds! / #disable_refunds!
export async function enableRefundsBang(record: UserRecord): Promise<UserRecord> {
  setFlag(record, "refunds_disabled", false);
  return Users.saveBang(record);
}

export async function disableRefundsBang(record: UserRecord): Promise<UserRecord> {
  setFlag(record, "refunds_disabled", true);
  return Users.saveBang(record);
}
