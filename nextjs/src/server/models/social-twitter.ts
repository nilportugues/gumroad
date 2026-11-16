// User.query_twitter and the link half of User::OmniauthCallbacksController (app/modules/user/social_twitter.rb): the Twitter (X) account a
// signed-in seller links is written to the user and to a SocialConnectVerification, and the profile picture of a seller with none is
// downloaded and attached (`twitterPictureUrl`, profile-picture.ts).
import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";

import { twitterPictureUrl } from "./profile-picture.ts";
import { recordSocialConnectEvent } from "./social-connect-funnel.ts";
import { presence, presentToI, record, rubyToS, stringColumn } from "./social-connect-verification.ts";
import { execute, selectRows, column, table } from "./sql.ts";
import { findUserBang, INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX, setPassword, type UserRecord, Users } from "./user.ts";

type Hash = Record<string, unknown>;
const isHash = (value: unknown): value is Hash => value !== null && typeof value === "object" && !Array.isArray(value);

const TWITTER_TIME =
  /^\s*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\s+(\d{4})\s*$/iu;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

// SocialConnectVerification.parse_twitter_time: Twitter's legacy "Sat Mar 21 16:47:01 +0000 2015", nil when it does not parse.
export function parseTwitterTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const match = TWITTER_TIME.exec(value);
  if (!match) return null;
  const [, month, day, hour, minute, second, sign, offsetHours, offsetMinutes, year] = match;
  const utc = Date.UTC(
    Number(year),
    MONTHS.indexOf(month!.toLowerCase()),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offset =
    (Number(offsetHours) * MINUTES_PER_HOUR + Number(offsetMinutes)) * MS_PER_MINUTE * (sign === "-" ? -1 : 1);
  const time = new Date(utc - offset);
  return Number.isNaN(time.getTime()) ? null : time;
}

// SocialConnectVerification.record_from_twitter!
async function recordFromTwitter(userId: bigint, rawInfo: Hash, now: () => Date, recordFunnelConnected: boolean) {
  const uid = rubyToS(rawInfo.id);
  const errors = rawInfo.errors;
  if (uid === "" || (errors !== null && errors !== undefined && errors !== false && presence(errors) !== null))
    return null;
  const status = rawInfo.status;
  return record(
    userId,
    "twitter",
    uid,
    {
      handle: stringColumn(rawInfo.screen_name),
      account_created_at: parseTwitterTime(rawInfo.created_at),
      follower_count: presentToI(rawInfo.followers_count),
      post_count: presentToI(rawInfo.statuses_count),
      last_posted_at: isHash(status) ? parseTwitterTime(status.created_at) : null,
    },
    now,
    recordFunnelConnected,
  );
}

// `data["entities"]["description"]["urls"].each { |url| data["description"].gsub!(url["url"], url["display_url"]) }`. A payload without
// entities raises NoMethodError in Rails, after the verifier was spent.
export class TwitterPayloadError extends Error {}

function expandDescription(data: Hash): void {
  const entities = data.entities;
  if (!isHash(entities)) throw new TwitterPayloadError("undefined method '[]' for nil");
  const description = entities.description;
  if (!isHash(description) || !Array.isArray(description.urls)) throw new TwitterPayloadError("no description urls");
  for (const entry of description.urls as unknown[]) {
    if (!isHash(entry) || typeof data.description !== "string" || typeof entry.url !== "string")
      throw new TwitterPayloadError("unexpected url entry");
    data.description = data.description.split(entry.url).join(String(entry.display_url ?? ""));
  }
}

const REVERT_TOKENS = { token: "twitter_oauth_token", secret: "twitter_oauth_secret" } as const;

// User.query_twitter(user, data, record_funnel_connected:) for a persisted user: the Twitter account and profile fields saved, the verification
// recorded and, for a user with no avatar, the profile picture attached.
export async function queryTwitter(
  user: UserRecord,
  data: Hash,
  now: () => Date,
  recordFunnelConnected: boolean,
): Promise<void> {
  const userId = BigInt(String(user.get("id")));
  user.set("twitter_user_id", data.id === null || data.id === undefined ? null : String(data.id));
  user.set("twitter_handle", (data.screen_name as string | null | undefined) ?? null);
  try {
    await recordFromTwitter(userId, data, now, recordFunnelConnected);
  } catch (error) {
    // Verification metadata feeds risk reviews; it must never break signup/link.
    console.error(
      `SocialConnectVerification twitter record failed for user ${String(userId)}: ${(error as Error).message}`,
    );
    await recordSocialConnectEvent({
      userId,
      stage: "failed",
      provider: "twitter",
      surface: "omniauth",
      extra: (error as Error).name,
      now,
    });
  }
  if (presence(user.get("name")) === null && typeof data.name === "string" && data.name.trim() !== "")
    user.set("name", data.name.replace(new RegExp(INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX.source, "gu"), ""));
  expandDescription(data);
  if (user.get("bio") === null) user.set("bio", (data.description as string | null | undefined) ?? null);
  if (presence(user.get("username")) === null) user.set("username", user.get("twitter_handle"));
  if (!(await Users.valid(user))) user.set("username", null);
  await Users.save(user, { now });
  if (!(await avatarAttached(userId))) await twitterPictureUrl(user, now);
}

// User::OmniauthCallbacksController#link_twitter_account over User.query_twitter(logged_in_user, data).
export async function linkTwitterAccount(
  userId: bigint,
  data: Hash,
  credentials: { token: string; secret: string },
  now: () => Date,
): Promise<void> {
  const user = await findUserBang(userId);
  await queryTwitter(user, data, now, true);

  user.assign({ [REVERT_TOKENS.token]: credentials.token, [REVERT_TOKENS.secret]: credentials.secret });
  await Users.saveBang(user, { now });
  // The new token replaces the read-only one that produced the reason, so the card must stop telling the seller they cannot post.
  await execute(
    Prisma.sql`UPDATE ${table("marketing_actions")} SET ${column("marketing_actions", "error_code")} = NULL, ${column("marketing_actions", "updated_at")} = ${now()} WHERE ${column("marketing_actions", "user_id")} = ${userId} AND ${column("marketing_actions", "status")} NOT IN ('posted', 'failed', 'cancelled') AND ${column("marketing_actions", "error_code")} = 'x_write_permission_missing'`,
  );
  await Users.save(user, { now });
}

// `user.avatar.attached?`
export async function avatarAttached(userId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_id")} = ${userId} AND ${column("active_storage_attachments", "record_type")} = 'User' AND ${column("active_storage_attachments", "name")} = 'avatar' LIMIT 1`,
  );
  return rows.length > 0;
}

// Devise.friendly_token(20): SecureRandom.urlsafe_base64(20).tr("lIO0", "sxyz")[0, 20]
const RANDOM_PASSWORD_LENGTH = 20;
export function friendlyToken(): string {
  return randomBytes(RANDOM_PASSWORD_LENGTH)
    .toString("base64url")
    .replace(/[lIO0]/gu, (c) => ({ l: "s", I: "x", O: "y", "0": "z" })[c]!)
    .slice(0, RANDOM_PASSWORD_LENGTH);
}

// User.find_or_create_for_twitter_oauth!(data) with `data["extra"]["raw_info"]` as `info`: the user holding the Twitter id, or a new one
// (provider twitter, a random password, confirmed), then query_twitter without the funnel's "connected" event. Rails raises on an invalid
// record (`save!`), and on an `errors` entry of the payload (a Hash answering `message`), both after the verifier was spent.
export async function findOrCreateForTwitterOauth(info: Hash, now: () => Date): Promise<UserRecord> {
  const twitterId = info.id === null || info.id === undefined ? null : String(info.id);
  const found =
    twitterId === null
      ? null
      : await db.user.findFirst({ where: { twitter_user_id: twitterId }, orderBy: { id: "asc" } });
  let user: UserRecord;
  if (found) user = await findUserBang(found.id);
  else {
    user = Users.build({});
    user.set("provider", "twitter");
    user.set("twitter_user_id", twitterId);
    await setPassword(user, friendlyToken());
    // skip_confirmation!
    user.set("confirmed_at", new Date(Math.floor(now().getTime() / 1000) * 1000));
    await Users.saveBang(user, { now });
  }
  const errors = info.errors;
  if (errors !== null && errors !== undefined && errors !== false && presence(errors) !== null)
    throw new TwitterPayloadError("undefined method 'message' for an instance of Hash");
  await queryTwitter(user, info, now, false);
  await Users.saveBang(user, { now });
  return user;
}
