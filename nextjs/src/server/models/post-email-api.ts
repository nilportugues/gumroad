// Port of PostEmailApi (app/services/post_email_api.rb) with PostResendApi and PostSendgridApi, for the
// workflow sends: which provider takes each recipient, the request each provider is sent, the
// `CreatorContactingCustomersEmailInfo` rows, the delivered counter and the push notifications.
//
// What Node cannot reproduce throws PostEmailNotPortedError (the sender then undoes its claim and
// hands the job back): a name Mail would quote or encode, a substitution value Ruby's `gsub!` would
// read as a back-reference, and whatever post-email-template.ts refuses. The provider requests are
// proven against the bodies the real classes build; the HTTP exchange itself (status handling,
// retries) is not provable that way and follows the gems' behaviour as read.
import { Prisma, type Follower, type Link, type Purchase, type User } from "@prisma/client";
import type { Redis } from "ioredis";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { stripTags } from "../html/sanitizer.ts";
import { getConfig } from "../infra/config.ts";
import { domainConfig } from "../infra/domain.ts";
import { isFeatureEnabled, userActor, type FlipperActor } from "../infra/flipper.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { getRedis } from "../infra/redis.ts";
import { performBulkWith } from "../jobs/push-bulk.ts";
import {
  EMAIL_PROVIDER_RESEND,
  EMAIL_PROVIDER_SENDGRID,
  buildHeaders,
  determineEmailProvider,
  forceSendgridForRecipients,
  mailDomains,
  type EmailProvider,
  type RouterDeps,
  defaultRouterDeps,
} from "../mail/mailer-info.ts";
import { PostEmailNotPortedError, renderPostEmail, type RenderedPostEmail } from "../mail/post-email-template.ts";
import { escapeSegment } from "../mail/routes.ts";
import { mailerUrl } from "../mail/views.ts";

import { currentJobsRuntime, performAsync } from "./concerns/job-runtime.ts";
import type { InstallmentPost } from "./installment-post.ts";
import { findById } from "./row-reads.ts";
import { connectedTo } from "./runtime/query-cache.ts";
import { transaction } from "./runtime/transaction.ts";
import { secureExternalId } from "./secure-external-id.ts";
import { column, execute, inList, isLockWaitTimeout, selectRows, table } from "./sql.ts";

export class ResendApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendApiResponseError";
  }
}

export class SendGridApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendGridApiResponseError";
  }
}

// PostFollowerHandoff::LockUnavailable: raised before anything reaches the provider, so a retry hands nothing over twice.
export class LockUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostFollowerHandoff::LockUnavailable";
  }
}

export const RESEND_MAX_RECIPIENTS = 100;
export const SENDGRID_MAX_RECIPIENTS = 1_000;
const HANDOFF_LOCK_WAIT_SECONDS = 10;
const RESEND_EXCLUDED_DOMAINS = ["example.com", "example.org", "example.net", "test.com"];
const PURCHASE_INSTALLMENT_MAILER_METHOD = "purchase_installment";
const FOLLOWER_INSTALLMENT_MAILER_METHOD = "follower_installment";
const DIRECT_AFFILIATE_INSTALLMENT_MAILER_METHOD = "direct_affiliate_installment";
const CREATOR_CONTACTING_CUSTOMERS_MAILER_CLASS = "CreatorContactingCustomersMailer";
const DELIVERED_DELTA_IDS = "installment:delivered_delta_ids";
const DELIVERED_DELTA_TTL_SECONDS = 2 * 24 * 60 * 60;
const FIRST_NAME_DEFAULT = "there";
const FIRST_NAME_TOKEN = /\{\{\s*first_name\s*(?:\|([^}]*))?\}\}/gu;

export type Recipient = {
  email: string;
  purchase?: Purchase;
  subscription?: { id: bigint };
  follower?: Follower;
  // The affiliate's user
  affiliate?: User;
};

export type ProviderTransport = {
  sendgrid(apiKey: string, body: unknown): Promise<{ status: number; body: string }>;
  resend(apiKey: string, kind: "email" | "batch", body: unknown): Promise<{ status: number; body: string }>;
};

export type PostEmailDeps = {
  now: () => Date;
  featureActive: (name: string, actor: FlipperActor | null) => Promise<boolean>;
  router: RouterDeps;
  // OpenSSL::Cipher#random_iv, for the unsubscribe tokens (12 bytes) and the Resend headers (16)
  randomIv: (bytes: number) => Buffer;
  transport: ProviderTransport;
  redis: () => Redis;
  // Whether Rails.application.config.action_mailer.perform_deliveries && !Rails.env.test?
  deliver: () => boolean;
  sleep: (seconds: number) => Promise<void>;
  log: (message: string) => void;
};

export const defaultPostEmailDeps = (): PostEmailDeps => ({
  now: () => new Date(),
  featureActive: (name, actor) => isFeatureEnabled(name, actor),
  router: defaultRouterDeps(),
  randomIv: (bytes) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))),
  transport: httpTransport,
  redis: () => getRedis("main"),
  deliver: () => process.env.ACTION_MAILER_SKIP_DELIVERIES !== "1" && railsEnv() !== "test",
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  log: (message) => console.info(message),
});

// ----- recipients

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && !/^[\t\n\v\f\r ]*$/u.test(value);

// PostEmailApi.valid_email_address_for_resend?
const MAIL_TO_EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/u;
export function validEmailAddressForResend(email: string | null | undefined): boolean {
  if (!present(email)) return false;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/u.test(email)) return false;
  if (email.length > 254) return false;
  // String#split drops trailing empty fields
  const parts = email.split("@");
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  const [localPart, domain] = parts;
  if (!present(localPart) || !present(domain)) return false;
  if (localPart.length > 64) return false;
  if (/[^a-zA-Z0-9.+_]/u.test(localPart)) return false;
  if (!domain.includes(".")) return false;
  if (RESEND_EXCLUDED_DOMAINS.includes(domain)) return false;
  return MAIL_TO_EMAIL.test(email);
}

// ----- the post's view of one recipient

// PostEmailPersonalization.resolve: the first word of the buyer's name, if the buyer has one.
export function personalizationName(recipient: Recipient): string | null {
  const name = recipient.purchase?.full_name;
  if (!present(name)) return null;
  const first = name.trim().split(/\s+/u)[0];
  return first === undefined || first === "" ? null : first;
}

const rubyStrip = (value: string) => value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r \0]+$/gu, "");
const tokenValue = (fallback: string | undefined, firstName: string | null) =>
  firstName ?? (present(fallback) ? rubyStrip(fallback) : FIRST_NAME_DEFAULT);

// PostEmailPersonalization.substitutions: one entry per distinct spelling of the token.
export function personalizationSubstitutions(content: string, firstName: string | null): [string, string][] {
  const seen = new Map<string, string>();
  for (const match of content.matchAll(FIRST_NAME_TOKEN)) {
    if (!seen.has(match[0])) seen.set(match[0], tokenValue(match[1], firstName));
  }
  return [...seen];
}

// PostEmailPersonalization.apply
export function applyPersonalization(content: string, firstName: string | null): string {
  return content.replace(FIRST_NAME_TOKEN, (_all, fallback: string | undefined) => tokenValue(fallback, firstName));
}

// MailerHelper#from_email_address_name for the names Mail formats without quoting or encoding.
const PLAIN_SENDER_NAME = /^[A-Za-z0-9 '-]+$/u;
export function fromEmailAddressName(name: string | null): string {
  if (!present(name)) return "Gumroad";
  const stripped = rubyStrip(name.replaceAll(":", ""));
  if (!PLAIN_SENDER_NAME.test(name) || stripped === "")
    throw new PostEmailNotPortedError("a sender name Mail would quote or encode");
  return stripped;
}

// MailerHelper#creators_from_email_address
const creatorsFromEmailAddress = (username: string | null) =>
  `${present(username) ? username : "creators"}@${mailDomains().creators}`;

// strip_tags(link.name): the text of the product name, with its markup escaped.
const sanitizedProductName = (link: Link) => stripTags(link.name);

// ----- the post, rendered once

export type PostEmailTemplate = {
  rendered: RenderedPostEmail;
  hasPostUrl: boolean;
  hasDownloadButton: boolean;
  hasCommentButton: boolean;
  hasSellerUpdateReason: boolean;
  sanitizedProductName: string | null;
};

async function renderTemplate(post: InstallmentPost, hasFiles: boolean): Promise<PostEmailTemplate> {
  const seller = await post.user();
  const profile = await post.sellerProfile(seller);
  // The profile's `seller` (custom_style_cache_name) is not loaded through the inverse.
  await post.loaded("profile_seller", () => findById<User>("User", seller.id));
  const hasPostUrl = post.flag("shown_on_profile");
  const hasCommentButton = post.flag("shown_on_profile") && post.flag("allow_comments");
  const hasSellerUpdateReason = post.sellerOrProductOrVariantType;
  const rendered = renderPostEmail({
    subject: await post.subject(),
    message: post.row.message,
    callToActionUrl: post.row.call_to_action_url,
    callToActionText: post.row.call_to_action_text,
    hasPostUrl,
    hasDownloadButton: hasFiles,
    hasCommentButton,
    hasSellerUpdateReason,
    profile,
  });
  let productName: string | null = null;
  if (post.productOrVariantType) {
    const link = await post.link();
    if (link === null) throw new TypeError("undefined method 'name' for nil");
    productName = sanitizedProductName(link);
  }
  return {
    rendered,
    hasPostUrl,
    hasDownloadButton: hasFiles,
    hasCommentButton,
    hasSellerUpdateReason,
    sanitizedProductName: productName,
  };
}

// CustomMailerRouteBuilder#build_mailer_post_route
async function postRoute(post: InstallmentPost, purchase: Purchase | undefined): Promise<string | null> {
  if (!post.flag("shown_on_profile") || !present(post.row.slug)) return null;
  const user = await post.user();
  const customDomain = await post.customDomain(user);
  const query: Record<string, string> = purchase === undefined ? {} : { purchase_id: encrypt(purchase.id) };
  if (customDomain !== null) {
    if (!present(customDomain.domain)) throw new PostEmailNotPortedError("a custom domain without a name");
    return `${mailerUrl(`/p/${escapeSegment(post.row.slug)}`, query).replace(/^[^:]+:\/\/[^/]+/u, (head) => head.replace(/\/\/.*/u, `//${customDomain.domain}`))}`;
  }
  const username = present(user.username) ? user.username : user.external_id;
  if (!present(username)) throw new PostEmailNotPortedError("a seller without a username or external id");
  return mailerUrl(`/${escapeSegment(username)}/p/${escapeSegment(post.row.slug)}`, query);
}

function unsubscribeUrl(recipient: Recipient, deps: PostEmailDeps): string {
  if (recipient.purchase !== undefined)
    return mailerUrl(
      `/purchases/${secureExternalId("Purchase", recipient.purchase.id, "unsubscribe", { randomIv: deps.randomIv })}/unsubscribe`,
    );
  if (recipient.follower !== undefined)
    return mailerUrl(`/follow/${escapeSegment(encrypt(recipient.follower.id))}/cancel`);
  if (recipient.affiliate !== undefined)
    return mailerUrl(`/affiliates/${escapeSegment(recipient.affiliate.external_id ?? "")}/unsubscribe_posts`);
  return "#";
}

const isFree = (purchase: Purchase | undefined) => purchase?.price_cents === 0 && purchase.shipping_cents === 0;

async function sellerUpdateReason(
  post: InstallmentPost,
  recipient: Recipient,
  template: PostEmailTemplate,
  wording: "post" | "email",
): Promise<string | null> {
  const seller = await post.seller();
  if (seller === null) throw new TypeError("undefined method 'name' for nil");
  const free = isFree(recipient.purchase);
  if (post.sellerType) {
    const sellerName = present(seller.name) ? seller.name : (seller.email ?? "Gumroad");
    return wording === "post"
      ? free
        ? `You've received this post because you got a product from ${sellerName}.`
        : `You've received this post because you've purchased a product from ${sellerName}.`
      : free
        ? `You've received this email because you got a product from ${sellerName}.`
        : `You've received this email because you've purchased a product from ${sellerName}.`;
  }
  if (!post.productOrVariantType) return null;
  const link = await post.link();
  if (link === null) throw new TypeError("undefined method 'long_url' for nil");
  const productName = template.sanitizedProductName;
  // Link#long_url: the seller's subdomain, else the root domain
  const target = await productUrl(post, link);
  const anchor = `<a href="${target}">${productName}</a>`;
  if (await post.memberCancellationTrigger())
    return `You've received this email because you cancelled your membership to ${anchor}.`;
  if (isRecurringBilling(link)) return `You've received this email because you subscribed to ${anchor}.`;
  if (free) return `You've received this email because you got ${anchor}.`;
  return `You've received this email because you've purchased ${anchor}.`;
}

const isRecurringBilling = (link: Link) => (BigInt(link.flags) & 2n) !== 0n;

// Link#long_url without options: the seller's subdomain, else the root domain
async function productUrl(post: InstallmentPost, link: Link): Promise<string> {
  const user = await post.loaded("link_user_for_url", async () =>
    link.user_id === null ? null : findById<User>("User", link.user_id),
  );
  if (user === null) throw new TypeError("undefined method 'subdomain_with_protocol' for nil");
  const permalink = present(link.custom_permalink) ? link.custom_permalink : link.unique_permalink;
  const { protocol, domain, rootDomain } = domainConfig();
  const host = present(user.username)
    ? `${protocol}://${user.username.replaceAll("_", "-")}.${rootDomain}`
    : `${protocol}://${domain}`;
  return `${host}/l/${escapeSegment(permalink ?? "")}`;
}

// ----- SendGrid

type Personalization = {
  to: { email: string }[];
  substitutions: Record<string, string>;
  custom_args: Record<string, string>;
};

function customArgs(recipient: Recipient, post: InstallmentPost): Record<string, string> {
  const args: Record<string, string> = {};
  if (recipient.purchase) args.purchase_id = String(recipient.purchase.id);
  if (recipient.subscription) args.subscription_id = String(recipient.subscription.id);
  if (recipient.follower) args.follower_id = String(recipient.follower.id);
  if (recipient.affiliate) args.affiliate_id = String(recipient.affiliate.id);
  const typed = (method: string, id: bigint | number) => {
    args.type = `CreatorContactingCustomersMailer.${method}`;
    args.identifier = `[${id}, ${post.id}]`;
  };
  if (recipient.purchase) typed(PURCHASE_INSTALLMENT_MAILER_METHOD, recipient.purchase.id);
  else if (recipient.follower) typed(FOLLOWER_INSTALLMENT_MAILER_METHOD, recipient.follower.id);
  else if (recipient.affiliate) typed(DIRECT_AFFILIATE_INSTALLMENT_MAILER_METHOD, recipient.affiliate.id);
  return args;
}

async function sendgridPersonalization(
  post: InstallmentPost,
  recipient: Recipient,
  template: PostEmailTemplate,
  deps: PostEmailDeps,
): Promise<Personalization> {
  const substitutions: Record<string, string> = { "{{subject}}": await post.subject() };
  if (template.hasPostUrl) {
    const postUrl = await postRoute(post, recipient.purchase);
    // SendGrid::Substitution with a nil value fails when the personalization is merged
    if (postUrl === null) throw new TypeError("no implicit conversion of nil into Hash");
    substitutions["{{post_url}}"] = postUrl;
  }
  if (template.hasDownloadButton) throw new PostEmailNotPortedError("a post with files");
  if (template.hasCommentButton) substitutions["{{t_post_a_comment}}"] = "Reply with a comment";
  if (template.hasSellerUpdateReason) {
    const reason = await sellerUpdateReason(post, recipient, template, "email");
    // the SendGrid wording of a seller post says "post"
    substitutions["{{seller_update_reason}}"] = (
      post.sellerType ? await sellerUpdateReason(post, recipient, template, "post") : reason
    )!;
  }
  substitutions["{{t_powered_by}}"] = "Powered by";
  substitutions["{{t_unsubscribe}}"] = "Unsubscribe";
  substitutions["{{unsubscribe_url}}"] = unsubscribeUrl(recipient, deps);
  for (const [key, value] of personalizationSubstitutions(template.rendered.html, personalizationName(recipient)))
    substitutions[key] = value;
  return { to: [{ email: recipient.email }], substitutions, custom_args: customArgs(recipient, post) };
}

// ----- Resend

async function resendEmail(
  post: InstallmentPost,
  recipient: Recipient,
  template: PostEmailTemplate,
  deps: PostEmailDeps,
): Promise<Record<string, unknown>> {
  const method = recipient.purchase
    ? PURCHASE_INSTALLMENT_MAILER_METHOD
    : recipient.follower
      ? FOLLOWER_INSTALLMENT_MAILER_METHOD
      : recipient.affiliate
        ? DIRECT_AFFILIATE_INSTALLMENT_MAILER_METHOD
        : null;
  if (method === null) throw new PostEmailNotPortedError("a recipient without a purchase, follower or affiliate");
  const mailerId = recipient.purchase?.id ?? recipient.follower?.id ?? recipient.affiliate?.id;
  const headers = buildHeaders({
    mailerClass: CREATOR_CONTACTING_CUSTOMERS_MAILER_CLASS,
    mailerMethod: method,
    mailerArgs: [Number(mailerId), post.id],
    emailProvider: EMAIL_PROVIDER_RESEND,
    randomIv: () => deps.randomIv(16),
  });
  const seller = await post.seller();
  if (seller === null) throw new TypeError("undefined method 'name' for nil");
  const subject = await post.subject();
  const from = `${fromEmailAddressName(seller.name)} <${creatorsFromEmailAddress(seller.username)}>`;
  const replyTo = await post.replyToEmail();
  return {
    from,
    reply_to: replyTo,
    to: [recipient.email],
    subject,
    html: await personalizeContent(post, template.rendered.html, recipient, template, deps),
    text: await personalizeContent(post, template.rendered.plaintext, recipient, template, deps),
    headers: Object.fromEntries(headers),
  };
}

async function personalizeContent(
  post: InstallmentPost,
  source: string,
  recipient: Recipient,
  template: PostEmailTemplate,
  deps: PostEmailDeps,
): Promise<string> {
  const substitutions: [string, string][] = [
    ["{{subject}}", await post.subject()],
    ["{{t_powered_by}}", "Powered by"],
    ["{{t_unsubscribe}}", "Unsubscribe"],
    ["{{unsubscribe_url}}", unsubscribeUrl(recipient, deps)],
  ];
  if (template.hasPostUrl) substitutions.push(["{{post_url}}", (await postRoute(post, recipient.purchase)) ?? ""]);
  if (template.hasDownloadButton) throw new PostEmailNotPortedError("a post with files");
  if (template.hasCommentButton) substitutions.push(["{{t_post_a_comment}}", "Reply with a comment"]);
  if (template.hasSellerUpdateReason)
    substitutions.push([
      "{{seller_update_reason}}",
      (await sellerUpdateReason(post, recipient, template, "email")) ?? "",
    ]);
  let content = source;
  for (const [key, value] of substitutions) {
    // `gsub!(string, string)` reads backslashes in the replacement as back-references.
    if (value.includes("\\")) throw new PostEmailNotPortedError("a substitution value with a backslash");
    content = content.replaceAll(key, () => value);
  }
  return applyPersonalization(content, personalizationName(recipient));
}

// ----- the handoff

type Handoff = (recipients: Recipient[]) => Promise<void>;

// PostFollowerHandoff.lock_live_follows: id => email of the follows still live at this seller, read under a
// share lock with a shorter lock wait.
async function lockLiveFollows(sellerId: bigint | number, followerIds: number[]): Promise<Map<number, string | null>> {
  let previous: unknown;
  try {
    [previous] = Object.values(
      (await selectRows<Record<string, unknown>>(Prisma.sql`SELECT @@SESSION.innodb_lock_wait_timeout`))[0] ?? {},
    );
    await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${HANDOFF_LOCK_WAIT_SECONDS}`));
    const existing = await selectRows<{ id: number }>(
      Prisma.sql`SELECT ${column("followers", "id")} FROM ${table("followers")} WHERE ${idCondition(followerIds)}`,
    );
    if (existing.length === 0) return new Map();
    const live = await selectRows<{ id: number; email: string | null }>(
      Prisma.sql`SELECT ${column("followers", "id")}, ${column("followers", "email")} FROM ${table("followers")} WHERE ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "confirmed_at")} IS NOT NULL AND ${idCondition(existing.map((row) => row.id))} AND ${column("followers", "followed_id")} = ${sellerId} FOR SHARE`,
    );
    return new Map(live.map((row) => [row.id, row.email]));
  } catch (error) {
    if (
      isLockWaitTimeout(error) ||
      (error instanceof Error && "errno" in error && (error as { errno: unknown }).errno === 1213)
    )
      throw new LockUnavailable(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (previous !== undefined && previous !== null && String(previous) !== "")
      await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(Number(previous))}`));
  }
}

const idCondition = (ids: number[]) =>
  ids.length === 1
    ? Prisma.sql`${column("followers", "id")} = ${ids[0]}`
    : Prisma.sql`${column("followers", "id")} IN ${inList(ids)}`;

const stillAtAddress = (liveEmail: string | null | undefined, recipientEmail: string) =>
  present(liveEmail) && liveEmail.trim().toLowerCase() === recipientEmail.trim().toLowerCase();

// PostFollowerHandoff.hold, without a newsletter admission (those posts are handed back before this).
async function hold(
  post: InstallmentPost,
  recipients: Recipient[],
  onWithheld: ((withheld: Recipient[]) => Promise<void>) | undefined,
  deps: PostEmailDeps,
  handoff: Handoff,
): Promise<Recipient[]> {
  if (recipients.length === 0) return recipients;
  const followerIds = [
    ...new Set(recipients.flatMap((recipient) => (recipient.follower === undefined ? [] : [recipient.follower.id]))),
  ];
  if (followerIds.length === 0) {
    await handoff(recipients);
    return recipients;
  }
  const sellerId = post.row.seller_id;
  if (sellerId === null) throw new PostEmailNotPortedError("a follower post without a seller");
  let withheld: Recipient[] = [];
  const admitted = await connectedTo("writing", () =>
    transaction(async () => {
      const liveEmails = await lockLiveFollows(sellerId, followerIds);
      const kept: Recipient[] = [];
      withheld = [];
      for (const recipient of recipients) {
        if (recipient.follower === undefined || stillAtAddress(liveEmails.get(recipient.follower.id), recipient.email))
          kept.push(recipient);
        else withheld.push(recipient);
      }
      if (kept.length > 0) await handoff(kept);
      return kept;
    }),
  );
  if (withheld.length > 0) {
    deps.log(`[PostFollowerHandoff] post_id=${post.id} withheld ${withheld.length} recipients whose follow ended`);
    await onWithheld?.(withheld);
  }
  return admitted;
}

// ----- provider calls

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const BACKOFF_SECONDS = [2, 8];

// TransientDeliveryRetry: only errors raised while the connection is opened are retried.
async function withTransientRetry<T>(deps: PostEmailDeps, context: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
      if (attempt > BACKOFF_SECONDS.length || code === undefined || !TRANSIENT_CODES.has(code)) throw error;
      deps.log(
        `[TransientDeliveryRetry] ${context} transient connection error on attempt ${attempt} (${String(error)}), retrying`,
      );
      await deps.sleep(BACKOFF_SECONDS[attempt - 1]!);
    }
  }
}

const httpTransport: ProviderTransport = {
  async sendgrid(apiKey, body) {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "sendgrid/6.7.0;ruby",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  },
  async resend(apiKey, kind, body) {
    const response = await fetch(`https://api.resend.com/${kind === "batch" ? "emails/batch" : "emails"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "resend-ruby:0.16.0",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  },
};

// ----- records after the handoff

async function createEmailInfoRecords(
  post: InstallmentPost,
  recipients: Recipient[],
  deps: PostEmailDeps,
): Promise<void> {
  const purchases = recipients.flatMap((recipient) =>
    recipient.purchase === undefined ? [] : [recipient.purchase.id],
  );
  if (purchases.length === 0) return;
  const sentAt = deps.now();
  const rows = purchases.map(
    (purchaseId) =>
      Prisma.sql`(${"CreatorContactingCustomersEmailInfo"}, ${post.id}, ${PURCHASE_INSTALLMENT_MAILER_METHOD}, ${"sent"}, ${sentAt}, ${purchaseId})`,
  );
  await execute(
    Prisma.sql`INSERT INTO ${table("email_infos")} (${Prisma.raw("`type`,`installment_id`,`email_name`,`state`,`sent_at`,`purchase_id`")}) VALUES ${Prisma.join(rows, ", ")} AS ${Prisma.raw("`email_infos_values`")}`,
  );
}

// Installment.buffer_delivered_delta
async function bufferDeliveredDelta(installmentId: number, by: number, deps: PostEmailDeps): Promise<void> {
  if (by === 0) return;
  const key = `installment:${installmentId}:delivered_delta`;
  try {
    await deps
      .redis()
      .multi()
      .incrby(key, by)
      .expire(key, DELIVERED_DELTA_TTL_SECONDS)
      .sadd(DELIVERED_DELTA_IDS, String(installmentId))
      .exec();
  } catch {
    await execute(
      Prisma.sql`UPDATE ${table("installments")} SET ${column("installments", "customer_count")} = COALESCE(${column("installments", "customer_count")}, 0) + ${by} WHERE ${column("installments", "id")} = ${installmentId}`,
    );
    return;
  }
  try {
    await performAsync("FlushInstallmentDeliveredDeltasJob", []);
  } catch {
    // The delta is buffered; the minute cron flushes it.
  }
}

export type ProcessArgs = {
  post: InstallmentPost;
  recipients: Recipient[];
  onWithheld?: (withheld: Recipient[]) => Promise<void>;
};

async function afterHandoff(post: InstallmentPost, delivered: Recipient[], deps: PostEmailDeps): Promise<void> {
  if (delivered.length === 0) return;
  await createEmailInfoRecords(post, delivered, deps);
  await bufferDeliveredDelta(post.id, delivered.length, deps);
  await pushNotifications(post, delivered);
}

async function pushNotifications(post: InstallmentPost, recipients: Recipient[]): Promise<void> {
  const emails = recipients.map((recipient) => recipient.email);
  const unique = [...new Set(emails)];
  const condition =
    unique.length === 1
      ? Prisma.sql`${column("users", "email")} = ${unique[0]}`
      : Prisma.sql`${column("users", "email")} IN ${inList(unique)}`;
  const users = await selectRows<{ id: bigint; email: string }>(
    Prisma.sql`SELECT ${column("users", "id")}, ${column("users", "email")} FROM ${table("users")} WHERE ${condition}`,
  );
  if (users.length === 0) return;
  const byEmail = new Map(users.map((user) => [user.email, user]));
  const seller = await post.seller();
  const subject = await post.subject();
  const argsList = recipients.flatMap((recipient) => {
    const user = byEmail.get(recipient.email);
    if (user === undefined) return [];
    const data: Record<string, string> = { installment_id: encrypt(post.id) };
    if (recipient.subscription) data.subscription_id = encrypt(recipient.subscription.id);
    if (recipient.purchase) data.purchase_id = encrypt(recipient.purchase.id);
    if (recipient.follower) data.follower_id = encrypt(recipient.follower.id);
    return [[Number(user.id), "consumer", subject, `By ${seller?.name ?? ""}`, data]];
  });
  await performBulkWith(currentJobsRuntime(), "PushNotificationWorker", argsList as never, { set: { queue: "low" } });
}

// ----- the two providers

async function validateRecipients(post: InstallmentPost, recipients: Recipient[], max: number): Promise<boolean> {
  if (recipients.length > max) throw new Error(`Too many recipients (${recipients.length} > ${max})`);
  const hasFiles = await post.hasFiles();
  for (const recipient of recipients) {
    if (!present(recipient.email)) throw new Error("Recipients must have an email");
    const roles = [recipient.purchase, recipient.follower, recipient.affiliate].filter(
      (record) => record !== undefined,
    ).length;
    if (roles > 1) throw new Error("Recipients can't have a purchase and/or a follower and/or an affiliate record");
  }
  return hasFiles;
}

async function processSendgrid(args: ProcessArgs, deps: PostEmailDeps): Promise<void> {
  const { post, recipients } = args;
  if (recipients.length === 0) return;
  const hasFiles = await validateRecipients(post, recipients, SENDGRID_MAX_RECIPIENTS);
  if (hasFiles) throw new PostEmailNotPortedError("a post with files");
  const template = await renderTemplate(post, hasFiles);
  const seller = await post.seller();
  if (seller === null) throw new TypeError("undefined method 'username' for nil");
  const from = { email: creatorsFromEmailAddress(seller.username), name: fromEmailAddressName(seller.name) };
  const subject = await post.subject();
  const replyTo = { email: await post.replyToEmail() };
  const personalizations = new Map<Recipient, Personalization>();
  for (const recipient of recipients)
    personalizations.set(recipient, await sendgridPersonalization(post, recipient, template, deps));
  const delivered = await hold(post, recipients, args.onWithheld, deps, async (kept) => {
    if (!deps.deliver()) {
      deps.log(
        `[PostSendgridApi] Would have sent post ${post.id} to ${kept.length} recipients (perform_deliveries = false)`,
      );
      return;
    }
    const body = {
      from,
      subject,
      personalizations: kept.map((recipient) => personalizations.get(recipient)),
      content: [
        { type: "text/plain", value: template.rendered.plaintext },
        { type: "text/html", value: template.rendered.html },
      ],
      categories: ["PostSendgridApi"],
      custom_args: { installment_id: String(post.id), seller_id: String(post.row.seller_id) },
      reply_to: replyTo,
    };
    const result = await withTransientRetry(deps, `PostSendgridApi post_id=${post.id}`, () =>
      deps.transport.sendgrid(getConfig("SENDGRID_GR_CREATORS_API_KEY") ?? "", body),
    );
    if (result.status < 200 || result.status > 299) throw new SendGridApiResponseError(result.body);
  });
  await afterHandoff(post, delivered, deps);
}

async function processResend(args: ProcessArgs, deps: PostEmailDeps): Promise<void> {
  const { post, recipients } = args;
  if (recipients.length === 0) return;
  const hasFiles = await validateRecipients(post, recipients, RESEND_MAX_RECIPIENTS);
  if (hasFiles) throw new PostEmailNotPortedError("a post with files");
  const template = await renderTemplate(post, hasFiles);
  const emails = new Map<Recipient, Record<string, unknown>>();
  for (const recipient of recipients) emails.set(recipient, await resendEmail(post, recipient, template, deps));
  const delivered = await hold(post, recipients, args.onWithheld, deps, async (kept) => {
    if (!deps.deliver()) {
      deps.log(
        `[PostResendApi] Would have sent post ${post.id} to ${kept.length} recipients (perform_deliveries = false)`,
      );
      return;
    }
    const batch = kept.map((recipient) => emails.get(recipient));
    const apiKey = getConfig("RESEND_CREATORS_API_KEY") ?? "";
    const result = await withTransientRetry(deps, `PostResendApi post_id=${post.id}`, () =>
      batch.length === 1
        ? deps.transport.resend(apiKey, "email", batch[0])
        : deps.transport.resend(apiKey, "batch", batch),
    );
    if (result.status < 200 || result.status > 299) throw new ResendApiResponseError(result.body);
  });
  await afterHandoff(post, delivered, deps);
}

// ----- PostEmailApi.process

async function providerFor(
  post: InstallmentPost,
  email: string,
  sellerActor: FlipperActor | null,
  deps: PostEmailDeps,
): Promise<EmailProvider> {
  if (!(await deps.featureActive("use_resend_for_post_emails", sellerActor))) return EMAIL_PROVIDER_SENDGRID;
  if (await deps.featureActive("force_resend_for_post_emails", sellerActor))
    return forceSendgridForRecipients(email) ? EMAIL_PROVIDER_SENDGRID : EMAIL_PROVIDER_RESEND;
  if (validEmailAddressForResend(email) && !forceSendgridForRecipients(email))
    return determineEmailProvider("creators", deps.router);
  return EMAIL_PROVIDER_SENDGRID;
}

export async function processPostEmail(args: ProcessArgs, deps: PostEmailDeps): Promise<void> {
  const { post, recipients } = args;
  const seller = await post.seller();
  const actor = seller === null ? null : userActor(seller.id);
  if (!(await deps.featureActive("use_resend_for_post_emails", actor))) return processSendgrid(args, deps);

  if (await deps.featureActive("force_resend_for_post_emails", actor)) {
    const blocked = recipients.filter((recipient) => forceSendgridForRecipients(recipient.email));
    const resendable = recipients.filter((recipient) => !forceSendgridForRecipients(recipient.email));
    if (resendable.length > 0) await processResend({ ...args, recipients: resendable }, deps);
    if (blocked.length > 0) await processSendgrid({ ...args, recipients: blocked }, deps);
    return;
  }

  const byProvider = new Map<EmailProvider, Recipient[]>();
  for (const recipient of recipients) {
    const provider = await providerFor(post, recipient.email, actor, deps);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), recipient]);
  }
  const resend = byProvider.get(EMAIL_PROVIDER_RESEND) ?? [];
  const sendgrid = byProvider.get(EMAIL_PROVIDER_SENDGRID) ?? [];
  if (resend.length > 0) await processResend({ ...args, recipients: resend }, deps);
  if (sendgrid.length > 0) await processSendgrid({ ...args, recipients: sendgrid }, deps);
}
