// The user_risk_state machine (app/models/user.rb `state_machine(:user_risk_state)`) and the
// User::Risk callbacks it runs (app/modules/user/risk.rb), on state_machines-activerecord 0.10.
// An event runs as one transaction: before callbacks, the save, then every after callback, so
// a callback that raises rolls the whole transition back.
import { Prisma, type Comment, type Link, type PlatformBlock } from "@prisma/client";

import { getRedis } from "../infra/redis.ts";

import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { COMMENT_TYPES, Comments } from "./comment.ts";
import { aliveCustomDomainOf, CustomDomainDeletable } from "./custom-domain.ts";
import { Events } from "./event.ts";
import { bannedAtValue, Links, type LinkRecord } from "./link.ts";
import { firstPartyMobileApplications, revokeAccessTokensFor } from "./oauth-application.ts";
import { PlatformBlocks, unblockPlatformBlock } from "./platform-block.ts";
import { transaction } from "./runtime/transaction.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, columnIn, findInBatches, quoteName, selectRows, table } from "./sql.ts";
import {
  findUserBang,
  nameOrUsername,
  normalizeGmailAddress,
  RISK_STATES,
  setFlag,
  subdomain,
  Users,
  type UserRecord,
} from "./user.ts";

export const RISK_EVENTS = [
  "mark_compliant",
  "mark_not_reviewed",
  "flag_for_tos_violation",
  "flag_for_fraud",
  "suspend_for_fraud",
  "suspend_for_tos_violation",
  "put_on_probation",
] as const;
export type RiskEvent = (typeof RISK_EVENTS)[number];

const ALL = null;
const TRANSITIONS: Record<RiskEvent, { from: readonly string[] | null; to: string }> = {
  mark_compliant: { from: ALL, to: "compliant" },
  mark_not_reviewed: { from: ["on_probation"], to: "not_reviewed" },
  flag_for_tos_violation: { from: ["not_reviewed", "compliant", "flagged_for_fraud"], to: "flagged_for_tos_violation" },
  flag_for_fraud: { from: ["not_reviewed", "compliant", "flagged_for_tos_violation"], to: "flagged_for_fraud" },
  suspend_for_fraud: { from: ["not_reviewed", "compliant", "on_probation", "flagged_for_fraud", "flagged_for_tos_violation"], to: "suspended_for_fraud" },
  suspend_for_tos_violation: { from: ["not_reviewed", "compliant", "on_probation", "flagged_for_tos_violation", "flagged_for_fraud"], to: "suspended_for_tos_violation" },
  put_on_probation: { from: ALL, to: "on_probation" },
};

// The hash every caller passes as the event's first argument.
export type TransitionParams = {
  author_id?: number | bigint | null;
  author_name?: string | null;
  content?: string | null;
  product_id?: number | bigint | null;
  bulk?: boolean;
  idempotency_key?: string | null;
  clear_suspension?: boolean | "if_suspended_by_account_cascade";
  skip_transition_callback?: "enable_sellers_other_accounts" | "suspend_sellers_other_accounts";
};

export class InvalidTransition extends Error {
  readonly rubyClass = "StateMachines::InvalidTransition";
  constructor(event: RiskEvent, from: string | null, reasons: string) {
    super(`Cannot transition user_risk_state via :${event} from :${from ?? ""} (Reason(s): ${reasons})`);
    this.name = "InvalidTransition";
  }
}

export class SuspensionClearNotAuthorizedError extends Error {
  readonly rubyClass = "User::Risk::SuspensionClearNotAuthorizedError";
  constructor(message: string) {
    super(message);
    this.name = "SuspensionClearNotAuthorizedError";
  }
}

export class RiskArgumentError extends Error {
  readonly rubyClass = "ArgumentError";
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export type RiskCollaborators = {
  // GmailAbuseFilter's $redis SADD / SREM.
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
};
const DEFAULT_COLLABORATORS: RiskCollaborators = {
  sadd: (key, member) => getRedis("main").sadd(key, member),
  srem: (key, member) => getRedis("main").srem(key, member),
};
let collaborators: RiskCollaborators = { ...DEFAULT_COLLABORATORS };
export function setRiskCollaborators(overrides: Partial<RiskCollaborators>): void {
  collaborators = { ...collaborators, ...overrides };
}
export function resetRiskCollaborators(): void {
  collaborators = { ...DEFAULT_COLLABORATORS };
}

const GMAIL_ABUSE_REDIS_KEY = "gmail_abuse:normalized_emails";
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const CASCADE_AUTHOR = "suspend_sellers_other_accounts";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Options = { now?: () => Date };
type Transition = { event: RiskEvent; from: string | null; to: string; params: TransitionParams | undefined; now: () => Date };

// Time.current.to_fs(:formatted_date_full_month): "%B %-d, %Y", and config.time_zone is UTC.
export const formattedDateFullMonth = (date: Date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
// String#humanize on a state name.
const humanize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replaceAll("_", " ");
const firstWord = (name: string) => name.match(/^[^_]*/u)![0];
const toBigInt = (value: unknown) => (value == null ? 0n : BigInt(value as bigint | number | string));

export function canFire(user: UserRecord, event: RiskEvent): boolean {
  const { from } = TRANSITIONS[event];
  return from === ALL || from.includes(user.get("user_risk_state") ?? "");
}

// `user.<event>!(params)`.
export async function fireRiskEventBang(user: UserRecord, event: RiskEvent, params?: TransitionParams, options: Options = {}): Promise<true> {
  await fire(user, event, params, options, true);
  return true;
}

// `user.<event>(params)`: false (with an error on user_risk_state) instead of InvalidTransition.
export function fireRiskEvent(user: UserRecord, event: RiskEvent, params?: TransitionParams, options: Options = {}): Promise<boolean> {
  return fire(user, event, params, options, false);
}

async function fire(user: UserRecord, event: RiskEvent, params: TransitionParams | undefined, options: Options, bang: boolean): Promise<boolean> {
  const from = user.get("user_risk_state");
  const { to } = TRANSITIONS[event];
  const humanEvent = event.replaceAll("_", " ");
  if (!canFire(user, event)) {
    if (bang) throw new InvalidTransition(event, from, `User risk state cannot transition via "${humanEvent}"`);
    user.errors.add("user_risk_state", "invalid_transition", { message: `cannot transition via "${humanEvent}"`, event: humanEvent, state: from });
    return false;
  }
  // before_transition any => flagged/suspended, :do => :not_verified?. It is the first callback for
  // those targets and reads no rows, so halting here matches Rails' lazily-opened transaction,
  // which never sends BEGIN.
  if ((to.startsWith("flagged_") || to.startsWith("suspended_")) && user.get("verified")) {
    if (bang) throw new InvalidTransition(event, from, "Transition halted");
    return false;
  }

  const transition: Transition = { event, from, to, params, now: options.now ?? (() => new Date()) };
  let saved = true;
  let reasons = "";
  await transaction(async () => {
    if (["compliant", "on_probation", "not_reviewed"].includes(to)) await refuseUnauthorizedSuspensionClear(user, transition);
    if (to === "compliant") await rebaseFlagsOntoLockedRow(user);
    user.set("user_risk_state", to);
    saved = await Users.save(user, { now: transition.now });
    if (!saved) {
      reasons = user.errors.fullMessages().join(", ");
      // state_machines rolls the attribute back and raises ActiveRecord::Rollback.
      user.set("user_risk_state", from);
      return false;
    }
    await runAfterCallbacks(user, transition);
    return true;
  }, { returningStatus: true });
  if (!saved && bang) throw new InvalidTransition(event, from, reasons);
  return saved;
}

async function refuseUnauthorizedSuspensionClear(user: UserRecord, transition: Transition): Promise<void> {
  if (user.newRecord) return;
  const [row] = await selectRows<{ user_risk_state: string | null }>(
    Prisma.sql`SELECT ${column("users", "user_risk_state")} FROM ${table("users")} WHERE ${column("users", "id")} = ${user.get("id")} LIMIT 1 FOR UPDATE`,
  );
  const persisted = row?.user_risk_state ?? null;
  if (!(RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(persisted)) return;
  const clear = transition.params?.clear_suspension;
  const authorized = clear === "if_suspended_by_account_cascade" ? await suspendedByAccountCascade(user) : !!clear;
  if (!authorized) throw new SuspensionClearNotAuthorizedError(`refusing to clear ${persisted}: the caller did not authorize clearing this suspension`);
}

async function suspendedByAccountCascade(user: UserRecord): Promise<boolean> {
  const [last] = await selectRows<{ author_name: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${column("comments", "commentable_id")} = ${user.get("id")} AND ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.SUSPENDED} ORDER BY ${column("comments", "created_at")} DESC, ${column("comments", "id")} DESC LIMIT 1`,
  );
  return last?.author_name === CASCADE_AUTHOR;
}

async function rebaseFlagsOntoLockedRow(user: UserRecord): Promise<void> {
  if (user.newRecord) return;
  const [row] = await selectRows<{ flags: unknown }>(
    Prisma.sql`SELECT ${column("users", "flags")} FROM ${table("users")} WHERE ${column("users", "id")} = ${user.get("id")} LIMIT 1 FOR UPDATE`,
  );
  const persisted = toBigInt(row?.flags);
  const callerFlags = toBigInt(user.get("flags"));
  const callerChangedBits = callerFlags ^ toBigInt(user.attributeInDatabase("flags"));
  user.set("flags", persisted);
  user.clearAttributeChanges(["flags"]);
  user.set("flags", (persisted & ~callerChangedBits) | (callerFlags & callerChangedBits));
}

const SUSPENDED = RISK_STATES.SUSPENDED as readonly (string | null)[];
const FLAGGED = RISK_STATES.FLAGGED as readonly (string | null)[];

const SUSPEND_JOB_DELAY_SECONDS = 5;

// The after_transition list of user.rb, in declaration order.
async function runAfterCallbacks(user: UserRecord, t: Transition): Promise<void> {
  const fromSuspended = SUSPENDED.includes(t.from);
  const toSuspended = SUSPENDED.includes(t.to);
  if (toSuspended) {
    await invalidateActiveSessions(user, t.now);
    await setLinksBannedAt(user, bannedAtValue(t.now()), t.now);
  }
  await addUserComment(user, t);
  if (t.to === "flagged_for_tos_violation") await addProductComment(user, t);
  if (toSuspended) {
    const id = user.get("id");
    const delay = { delaySeconds: SUSPEND_JOB_DELAY_SECONDS };
    if (t.params?.skip_transition_callback !== "suspend_sellers_other_accounts") await performAsync("SuspendAccountsWithPaymentAddressWorker", [id], delay);
    await performAsync("BlockSuspendedAccountIpWorker", [id], delay);
    await performAsync("RemoveSuspendedAccountFollowsWorker", [id], delay);
    await deleteCustomDomain(user, t.now);
  }
  if (FLAGGED.includes(t.to) || toSuspended) await addToGmailAbuseFilter(user);
  if (t.to === "compliant") {
    setFlag(user, "refunds_disabled", false);
    await Users.saveBang(user, { now: t.now });
    await recordSocialConnectHoldReleased(user, t.now);
    const id = user.get("id");
    await afterCommitEverywhere(() => performAsync("LiftPlatformStripePauseJob", [id]));
  }
  const toCleared = t.to === "compliant" || t.to === "on_probation";
  if (fromSuspended && toCleared) await setLinksBannedAt(user, null, t.now);
  if ((fromSuspended || t.from === "not_reviewed") && toCleared) await unblockSellerIp(user, t.now);
  if (fromSuspended && t.to === "compliant" && t.params?.skip_transition_callback !== "enable_sellers_other_accounts") await enableSellersOtherAccounts(user, t.now);
  if (fromSuspended && toCleared && subdomain(user)) await performAsync("CreateStripeApplePayDomainWorker", [user.get("id")]);
  if ((fromSuspended || FLAGGED.includes(t.from)) && toCleared) await removeFromGmailAbuseFilter(user);
}

const COMMENT_CONTENT: Record<string, (author: string | null, date: string) => string> = {
  compliant: (a, d) => `Marked compliant by ${a} on ${d}`,
  not_reviewed: (a, d) => `Marked "Not Reviewed" by ${a} on ${d}`,
  on_probation: (a, d) => `Probated (payouts suspended) by ${a} on ${d}`,
  flagged_for_tos_violation: (a, d) => `Flagged for a policy violation by ${a} on ${d}`,
  flagged_for_fraud: (a, d) => `Flagged for fraud by ${a} on ${d}`,
  suspended_for_tos_violation: (a, d) => `Suspended for a policy violation by ${a} on ${d}`,
  suspended_for_fraud: (a, d) => `Suspended for fraud by ${a} on ${d}`,
};
const COMMENT_TYPE: Record<string, string> = {
  compliant: COMMENT_TYPES.COMPLIANT,
  not_reviewed: COMMENT_TYPES.NOT_REVIEWED,
  on_probation: COMMENT_TYPES.ON_PROBATION,
  flagged_for_fraud: COMMENT_TYPES.FLAGGED,
  flagged_for_tos_violation: COMMENT_TYPES.FLAGGED,
  suspended_for_fraud: COMMENT_TYPES.SUSPENDED,
  suspended_for_tos_violation: COMMENT_TYPES.SUSPENDED,
};

async function findProductName(productId: unknown): Promise<string | null> {
  const [row] = await selectRows<{ name: string | null }>(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1`);
  if (!row) throw Object.assign(new Error(`Couldn't find Link with 'id'=${String(productId)}`), { rubyClass: "ActiveRecord::RecordNotFound" });
  return row.name;
}

async function addUserComment(user: UserRecord, t: Transition): Promise<void> {
  const params = t.params;
  if (!params || (!params.author_id && !params.author_name)) throw new RiskArgumentError("first transition argument must include an author_id or author_name");
  const authorName = params.author_name || nameOrUsername(await findUserBang(params.author_id));
  const date = formattedDateFullMonth(t.now());
  let content = COMMENT_CONTENT[t.to]!(authorName, date);
  if (t.to === "flagged_for_tos_violation" && params.product_id != null) {
    content += ` for product named '${await findProductName(params.product_id)}'`;
  }
  await Comments.createBang(
    {
      commentable_id: BigInt(user.get("id") as bigint),
      commentable_type: "User",
      content: params.content || content,
      author_id: params.author_id == null ? null : BigInt(params.author_id),
      author_name: params.author_name ?? null,
      comment_type: COMMENT_TYPE[t.to]!,
      idempotency_key: params.idempotency_key ?? null,
    } as Partial<Comment>,
    { now: t.now },
  );
}

async function addProductComment(user: UserRecord, t: Transition): Promise<void> {
  const params = t.params;
  if (params?.bulk) return;
  if (!params || !params.product_id) throw new RiskArgumentError("first transition argument must include a product_id");
  const [product] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${params.product_id} LIMIT 1`);
  if (!product) throw new TypeError("undefined method 'comments' for nil");
  await Comments.createBang(
    {
      commentable_id: BigInt(product.id),
      commentable_type: "Link",
      content: params.content || `${humanize(t.to)} as ${user.get("tos_violation_reason") ?? ""}`,
      author_id: params.author_id == null ? null : BigInt(params.author_id),
      author_name: params.author_name ?? null,
      comment_type: firstWord(t.to),
    } as Partial<Comment>,
    { now: t.now },
  );
}

async function addToGmailAbuseFilter(user: UserRecord): Promise<void> {
  const normalized = normalizeGmailAddress(user.get("email"));
  if (normalized === null || !GMAIL_DOMAINS.includes(normalized.split("@", 2)[1] ?? "")) return;
  await collaborators.sadd(GMAIL_ABUSE_REDIS_KEY, normalized);
}

async function removeFromGmailAbuseFilter(user: UserRecord): Promise<void> {
  const normalized = normalizeGmailAddress(user.get("email"));
  if (normalized === null) return;
  await collaborators.srem(GMAIL_ABUSE_REDIS_KEY, normalized);
}

// SocialConnectVerification#currently_linked?'s reads: `user.<platform>_identity` (has_one, kept
// on the user instance once loaded).
const IDENTITIES: Record<string, { table: string; column: string }> = {
  youtube: { table: "user_youtube_identities", column: "channel_id" },
  instagram: { table: "user_instagram_identities", column: "instagram_user_id" },
  tiktok: { table: "user_tiktok_identities", column: "tiktok_open_id" },
};
const IDENTITY_CACHE = Symbol("identities");

async function identityValue(user: UserRecord, platform: string): Promise<unknown> {
  const ivars = user.ivars as Record<symbol, Map<string, Record<string, unknown> | null> | undefined>;
  const cache = (ivars[IDENTITY_CACHE] ??= new Map());
  const { table: identities, column: name } = IDENTITIES[platform]!;
  if (!cache.has(platform)) {
    const [row] = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT ${Prisma.raw(`${quoteName(identities)}.*`)} FROM ${table(identities)} WHERE ${column(identities, "user_id")} = ${user.get("id")} LIMIT 1`,
    );
    cache.set(platform, row ?? null);
  }
  return cache.get(platform)?.[name] ?? null;
}

async function currentlyLinked(user: UserRecord, verification: { platform: string | null; uid: unknown; superseded_at: unknown }): Promise<boolean> {
  if (verification.superseded_at != null) return false;
  const platform = verification.platform ?? "";
  let value: unknown;
  if (platform === "twitter") value = user.get("twitter_user_id");
  else if (platform in IDENTITIES) value = await identityValue(user, platform);
  else return false;
  return !isBlank(value) && String(value) === String(verification.uid ?? "");
}

// SocialConnectFunnel.record_hold_released!(user, surface: "mark_compliant"), which rescues and
// logs every StandardError, as SocialConnectFunnel.record! does for each event.
async function recordSocialConnectHoldReleased(user: UserRecord, now: () => Date): Promise<void> {
  const userId = user.get("id");
  const surface = "mark_compliant";
  const log = (error: unknown, what = "hold_released") =>
    console.error(`SocialConnectFunnel ${what} failed for user ${String(userId)}: ${(error as Error).name}: ${(error as Error).message}`);
  try {
    const [offer] = await selectRows<Record<string, Date | null>>(
      Prisma.sql`SELECT MAX(${column("events", "created_at")}) FROM ${table("events")} WHERE ${column("events", "user_id")} = ${userId} AND ${column("events", "event_name")} = 'social_connect_offered'`,
    );
    const verifications = await selectRows<{ platform: string | null; uid: unknown; superseded_at: unknown }>(
      Prisma.sql`SELECT ${Prisma.raw("`social_connect_verifications`.*")} FROM ${table("social_connect_verifications")} WHERE ${column("social_connect_verifications", "user_id")} = ${userId} AND ${column("social_connect_verifications", "superseded_at")} IS NULL`,
    );
    const linked: string[] = [];
    for (const verification of verifications) {
      if ((await currentlyLinked(user, verification)) && !linked.includes(verification.platform!)) linked.push(verification.platform!);
    }
    const lastOfferAt = offer ? (Object.values(offer)[0] ?? null) : null;
    const since = lastOfferAt ? Prisma.sql` AND (created_at >= ${lastOfferAt})` : Prisma.empty;
    for (const provider of linked.length === 0 ? ["none"] : linked) {
      const [exists] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("events")} WHERE ${column("events", "user_id")} = ${userId} AND ${column("events", "event_name")} = 'social_connect_hold_released' AND ${column("events", "parent_referrer")} = ${provider} AND ${column("events", "view_url")} = ${surface}${since} LIMIT 1`,
      );
      if (exists) continue;
      try {
        await Events.createBang({ event_name: "social_connect_hold_released", user_id: BigInt(userId as bigint), parent_referrer: provider, view_url: surface, referrer: null } as never, { now });
      } catch (error) {
        log(error, `hold_released/${provider}`);
      }
    }
  } catch (error) {
    log(error);
  }
}

// invalidate_active_sessions!
async function invalidateActiveSessions(user: UserRecord, now: () => Date): Promise<void> {
  await Users.updateBang(user, { last_active_sessions_invalidated_at: new Date(Math.floor(now().getTime() / 1000) * 1000) }, { now });
  for (const application of await firstPartyMobileApplications()) await revokeAccessTokensFor(application, user.get("id"), now);
}

const LINKS = Symbol("links");

// `user.links`: loaded once per user instance, each product with the user as its inverse.
async function userLinks(user: UserRecord): Promise<LinkRecord[]> {
  const ivars = user.ivars as Record<symbol, LinkRecord[] | undefined>;
  if (ivars[LINKS]) return ivars[LINKS];
  const rows = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${user.get("id")}`);
  const links = rows.map((row) => {
    const link = Links.load(castRow<Link>("Link", row));
    // Setting the inverse reads the foreign key, which PaperTrail's object order then shows.
    link.attributeChanged("user_id");
    setAssociation(link, "user", link.get("user_id"), user.attributes);
    return link;
  });
  ivars[LINKS] = links;
  return links;
}

// disable_links_and_tell_chat / enable_links_and_tell_chat: `link.update(banned_at:)`, whose
// false return (an invalid product) is ignored.
async function setLinksBannedAt(user: UserRecord, bannedAt: Date | null, now: () => Date): Promise<void> {
  for (const link of await userLinks(user)) await Links.update(link, { banned_at: bannedAt }, { now });
}

// delete_custom_domain!
async function deleteCustomDomain(user: UserRecord, now: () => Date): Promise<void> {
  const domain = await aliveCustomDomainOf(user.get("id"), user.attributes);
  if (domain === null) return;
  await CustomDomainDeletable.markDeletedBang(domain, { now });
}

async function unblockSellerIp(user: UserRecord, now: () => Date): Promise<void> {
  const ip = user.get("last_sign_in_ip");
  if (ip == null || String(ip).trim() === "") return;
  const where = Prisma.sql`${column("platform_blocks", "object_type")} = 'ip_address' AND ${column("platform_blocks", "object_value")} = ${ip}`;
  await findInBatches("platform_blocks", where, 1000, async (rows) => {
    for (const row of rows) await unblockPlatformBlock(PlatformBlocks.load(castRow<PlatformBlock>("PlatformBlock", row)), now);
  });
}

async function enableSellersOtherAccounts(user: UserRecord, now: () => Date): Promise<void> {
  const id = user.get("id");
  const date = formattedDateFullMonth(now());
  const paymentAddress = user.get("payment_address");
  if (paymentAddress != null && String(paymentAddress).trim() !== "") {
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "payment_address")} = ${paymentAddress} AND ${column("users", "id")} != ${id}`,
    );
    for (const row of rows) {
      await releaseCascadeSuspendedSibling(
        Users.load(castRow("User", row)),
        `Marked compliant automatically on ${date} as payment address ${String(paymentAddress)} is now unblocked (from User#${String(id)})`,
        now,
      );
    }
  }

  const fingerprints = (
    await selectRows<{ stripe_fingerprint: string }>(
      Prisma.sql`SELECT DISTINCT ${column("bank_accounts", "stripe_fingerprint")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${id} AND NOT ((${column("bank_accounts", "stripe_fingerprint")} = '' OR ${column("bank_accounts", "stripe_fingerprint")} IS NULL))`,
    )
  ).map((r) => r.stripe_fingerprint);
  if (fingerprints.length === 0) return;
  const userIds = (
    await selectRows<{ user_id: bigint }>(
      Prisma.sql`SELECT DISTINCT ${column("bank_accounts", "user_id")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "deleted_at")} IS NULL AND ${columnIn("bank_accounts", "stripe_fingerprint", fingerprints)} AND ${column("bank_accounts", "user_id")} != ${id}`,
    )
  ).map((r) => r.user_id);
  const siblings = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${columnIn("users", "id", userIds)}`);
  for (const row of siblings) {
    const sibling = Users.load(castRow("User", row));
    const theirs = (
      await selectRows<{ stripe_fingerprint: string | null }>(
        Prisma.sql`SELECT ${column("bank_accounts", "stripe_fingerprint")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${sibling.get("id")} AND ${column("bank_accounts", "deleted_at")} IS NULL`,
      )
    ).map((r) => r.stripe_fingerprint);
    const matching = fingerprints.find((f) => theirs.includes(f));
    await releaseCascadeSuspendedSibling(
      sibling,
      `Marked compliant automatically on ${date} as bank account fingerprint ${matching ?? ""} is now unblocked (from User#${String(id)})`,
      now,
    );
  }
}

async function releaseCascadeSuspendedSibling(sibling: UserRecord, content: string, now: () => Date): Promise<void> {
  try {
    await fireRiskEventBang(
      sibling,
      "mark_compliant",
      { author_name: "enable_sellers_other_accounts", content, skip_transition_callback: "enable_sellers_other_accounts", clear_suspension: "if_suspended_by_account_cascade" },
      { now },
    );
  } catch (error) {
    if (!(error instanceof SuspensionClearNotAuthorizedError)) throw error;
  }
}

