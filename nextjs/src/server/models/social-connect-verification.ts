// SocialConnectVerification.record_from_youtube!/_instagram!/_tiktok! (app/models/social_connect_verification.rb) and the three identity models
// the connect callbacks upsert (UserYoutubeIdentity, UserInstagramIdentity, UserTiktokIdentity). record_from_twitter! is not ported.
import {
  Prisma,
  type SocialConnectVerification,
  type UserInstagramIdentity,
  type UserTiktokIdentity,
  type UserYoutubeIdentity,
} from "@prisma/client";

import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { validatesInclusionOf, validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";
import { recordSocialConnectEvent } from "./social-connect-funnel.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const VERIFICATIONS = "social_connect_verifications";
export const SOCIAL_CONNECT_PLATFORMS = ["twitter", "youtube", "instagram", "tiktok"] as const;
const USER = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" } as const;

export const SocialConnectVerifications = defineModel<SocialConnectVerification>({
  rubyClass: "SocialConnectVerification",
  prismaModel: "SocialConnectVerification",
  delegate: (tx) => tx.socialConnectVerification as never,
  validations: [
    belongsToRequired<SocialConnectVerification>(USER),
    validatesPresenceOf<SocialConnectVerification>(["platform"], {}),
    validatesInclusionOf<SocialConnectVerification>(["platform"], { in: SOCIAL_CONNECT_PLATFORMS }),
    validatesPresenceOf<SocialConnectVerification>(["uid"], {}),
    validatesPresenceOf<SocialConnectVerification>(["last_verified_at"], {}),
    // Superseded rows are kept as veto evidence, so only the live row per platform is unique.
    validatesUniquenessOf<SocialConnectVerification>(VERIFICATIONS, ["platform"], {
      scope: ["user_id"],
      conditions: `\`${VERIFICATIONS}\`.\`superseded_at\` IS NULL`,
      unless: (record) => record.get("superseded_at") != null,
    }),
  ],
});

export const UserYoutubeIdentities = defineModel<UserYoutubeIdentity>({
  rubyClass: "UserYoutubeIdentity",
  prismaModel: "UserYoutubeIdentity",
  delegate: (tx) => tx.userYoutubeIdentity as never,
  validations: [
    belongsToRequired<UserYoutubeIdentity>(USER),
    validatesPresenceOf<UserYoutubeIdentity>(["channel_id"], {}),
    validatesUniquenessOf<UserYoutubeIdentity>("user_youtube_identities", ["user_id"], {}),
  ],
});

export const UserInstagramIdentities = defineModel<UserInstagramIdentity>({
  rubyClass: "UserInstagramIdentity",
  prismaModel: "UserInstagramIdentity",
  delegate: (tx) => tx.userInstagramIdentity as never,
  validations: [
    belongsToRequired<UserInstagramIdentity>(USER),
    validatesPresenceOf<UserInstagramIdentity>(["instagram_user_id"], {}),
    validatesUniquenessOf<UserInstagramIdentity>("user_instagram_identities", ["user_id"], {}),
  ],
});

export const UserTiktokIdentities = defineModel<UserTiktokIdentity>({
  rubyClass: "UserTiktokIdentity",
  prismaModel: "UserTiktokIdentity",
  delegate: (tx) => tx.userTiktokIdentity as never,
  validations: [
    belongsToRequired<UserTiktokIdentity>(USER),
    validatesPresenceOf<UserTiktokIdentity>(["tiktok_open_id"], {}),
    validatesUniquenessOf<UserTiktokIdentity>("user_tiktok_identities", ["user_id"], {}),
  ],
});

// Object#presence for a value read out of JSON: nil for null, false, a blank string and an empty array or hash.
export function presence(value: unknown): unknown {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (Array.isArray(value)) return value.length === 0 ? null : value;
  if (typeof value === "object") return Object.keys(value).length === 0 ? null : value;
  return value;
}

// NoMethodError and TypeError are what the Ruby code raises on a value of the wrong type; the callbacks report the class name.
export class RubyError extends Error {
  constructor(
    readonly rubyClass: string,
    message: string,
  ) {
    super(message);
    this.name = rubyClass;
  }
}

// String#to_i on a string, Integer#to_i/Float#to_i on a number; a value without #to_i (true, an array, a hash) is a NoMethodError.
export function toI(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(value);
    return match ? BigInt(match[1]!.replaceAll("_", "")) : 0n;
  }
  throw new RubyError("NoMethodError", "undefined method 'to_i'");
}

// `value.presence&.to_i`
const presentToI = (value: unknown): bigint | null => {
  const present = presence(value);
  return present === null ? null : toI(present);
};

// Kernel#Integer for the values a profile carries, nil where it raises ArgumentError or TypeError (`int_or_unknown`).
export function intOrUnknown(value: unknown): bigint | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : nonFinite();
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match =
    /^([+-]?)(0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0[bB][01]+(?:_[01]+)*|0[oO]?[0-7]+(?:_[0-7]+)*|0|[1-9]\d*(?:_\d+)*)$/u.exec(
      text,
    );
  if (!match) return null;
  const digits = match[2]!.replaceAll("_", "");
  const magnitude = /^0[xXbBoO]/u.test(digits)
    ? BigInt(digits.toLowerCase())
    : digits.length > 1 && digits.startsWith("0")
      ? BigInt(`0o${digits.slice(1)}`)
      : BigInt(digits);
  return match[1] === "-" ? -magnitude : magnitude;
}

const nonFinite = (): never => {
  throw new RubyError("FloatDomainError", "Infinity");
};

const ISO8601 = /^\s*(-?\d+)-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)(\.\d+)?)?(Z|[+-]\d\d(?::?\d\d)?)?\s*$/u;

// Time.iso8601, nil where it raises ArgumentError. A time without a zone is read in the server's (UTC).
export function parseIso8601(value: unknown): Date | null {
  if (value === null || value === undefined || value === false || (typeof value === "string" && value.trim() === ""))
    return null;
  const match = ISO8601.exec(String(value));
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", zone = "Z"] = match;
  const offset =
    zone === "Z"
      ? "Z"
      : zone.length === 3
        ? `${zone}:00`
        : zone.includes(":")
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const padded = `${year!.padStart(4, "0")}-${month}-${day}T${hour}:${minute}:${second}${fraction.slice(0, 4)}${offset}`;
  const time = new Date(padded);
  if (Number.isNaN(time.getTime())) return null;
  // Time.iso8601 refuses a date that does not exist (February 30) where Date rolls it over.
  if (time.toISOString().slice(5, 10) !== `${month}-${day}` && offset === "Z") return null;
  return time;
}

type Attributes = {
  handle: string | null;
  account_created_at: Date | null;
  follower_count: bigint | null;
  post_count: bigint | null;
  last_posted_at: Date | null;
};

// A string column keeps a string as is; the numbers a provider sends as a handle are stored as their digits.
function stringColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  throw new RubyError("NotPorted", "a handle that is neither a string nor an integer");
}

// SocialConnectVerification.record!: the same identity refreshes in place, a different one supersedes the live row so the old uid
// keeps vetoing, and a reconnect revives the matching prior row.
async function record(
  userId: bigint,
  platform: string,
  uid: string,
  attributes: Attributes,
  now: () => Date,
): Promise<ModelRecord<SocialConnectVerification>> {
  return transaction(async () => {
    // User.lock.find: a fresh row, so the caller's dirty User never matters.
    await selectRows(
      Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1 FOR UPDATE`,
    );
    const find = async (where: Prisma.Sql) => {
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw(`\`${VERIFICATIONS}\`.*`)} FROM ${table(VERIFICATIONS)} WHERE ${where} LIMIT 1`,
      );
      return row
        ? SocialConnectVerifications.load(castRow<SocialConnectVerification>("SocialConnectVerification", row))
        : null;
    };
    const byUser = Prisma.sql`${column(VERIFICATIONS, "user_id")} = ${userId} AND ${column(VERIFICATIONS, "platform")} = ${platform}`;
    const buildFor = (extra: Partial<SocialConnectVerification>) =>
      SocialConnectVerifications.build({ user_id: userId, platform, ...extra });
    const findOrInitializeByUid = async () =>
      (await find(Prisma.sql`${byUser} AND ${column(VERIFICATIONS, "uid")} = ${uid}`)) ?? buildFor({ uid });

    let verification = await find(Prisma.sql`${byUser} AND ${column(VERIFICATIONS, "superseded_at")} IS NULL`);
    if (verification && verification.get("uid") !== uid) {
      // supersede!: `return if superseded?` cannot apply, the row was found by `superseded_at IS NULL`.
      await SocialConnectVerifications.updateBang(verification, { superseded_at: now() }, { now });
      verification = await findOrInitializeByUid();
    } else if (!verification) {
      verification = await findOrInitializeByUid();
    }
    await SocialConnectVerifications.updateBang(
      verification,
      { uid, superseded_at: null, last_verified_at: now(), ...attributes },
      { now },
    );
    await recordSocialConnectEvent({ userId, stage: "connected", provider: platform, surface: "omniauth", now });
    return verification;
  });
}

type Hash = Record<string, unknown>;

// YouTube Data API channel payload from YoutubeChannelFetcher.
export async function recordFromYoutube(userId: bigint, channel: Hash, now: () => Date) {
  const uid = rubyToS(channel.id);
  if (uid === "") return null;
  return record(
    userId,
    "youtube",
    uid,
    {
      handle: stringColumn(channel.handle),
      account_created_at: parseIso8601(channel.published_at),
      follower_count: presentToI(channel.subscriber_count),
      post_count: presentToI(channel.video_count),
      last_posted_at:
        channel.last_posted_at instanceof Date ? channel.last_posted_at : parseIso8601(channel.last_posted_at),
    },
    now,
  );
}

export async function recordFromTiktok(userId: bigint, profile: Hash, now: () => Date) {
  const uid = rubyToS(profile.open_id);
  if (uid === "") return null;
  return record(
    userId,
    "tiktok",
    uid,
    {
      handle: stringColumn(tiktokHandle(profile)),
      account_created_at: null,
      follower_count: intOrUnknown(profile.follower_count),
      post_count: intOrUnknown(profile.video_count),
      last_posted_at: null,
    },
    now,
  );
}

export async function recordFromInstagram(userId: bigint, profile: Hash, now: () => Date) {
  // Meta's deauthorize and data deletion callbacks carry the app-scoped (token) user id, so that is the canonical uid.
  const uid = rubyToS(presence(profile.token_user_id) ?? presence(profile.user_id) ?? profile.id);
  if (uid === "") return null;
  return record(
    userId,
    "instagram",
    uid,
    {
      handle: stringColumn(profile.username),
      account_created_at: null,
      follower_count: presentToI(profile.followers_count),
      post_count: presentToI(profile.media_count),
      last_posted_at: parseIso8601(profile.last_posted_at),
    },
    now,
  );
}

// `profile["username"].presence || profile["profile_web_link"].to_s[%r{@([^/?#]+)}, 1].presence || profile["display_name"].presence`
function tiktokHandle(profile: Hash): unknown {
  const link = /@([^/?#]+)/u.exec(rubyToS(profile.profile_web_link))?.[1];
  return presence(profile.username) ?? presence(link) ?? presence(profile.display_name);
}

// Object#to_s for a value out of JSON (nil is the empty string); a hash or array has Ruby's inspect form, which no id takes.
function rubyToS(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") throw new RubyError("NotPorted", "an id that is a hash or an array");
  return String(value);
}

// `identity = user.<provider>_identity || user.build_<provider>_identity; identity.update!(...)`
export async function upsertIdentity<R extends { id: bigint; user_id: bigint }>(
  model: ReturnType<typeof defineModel<R>>,
  tableName: string,
  userId: bigint,
  attributes: Partial<R>,
  now: () => Date,
): Promise<void> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "user_id")} = ${userId} LIMIT 1`,
  );
  const prismaModel = model.definition.prismaModel;
  const identity = row ? model.load(castRow<R>(prismaModel, row)) : model.build({ user_id: userId } as Partial<R>);
  await model.updateBang(identity, attributes, { now });
}
