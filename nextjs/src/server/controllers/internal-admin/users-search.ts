// Api::Internal::Admin::UsersController#purchases, #related, #social_connections and #radar_stats: reads over rows the user (or the
// sellers' fraud signals) own. #info and the social connections of a platform other than Twitter stay with Rails (Stripe, the
// payout schedule, the identity tables).
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { NotPortedError } from "../../models/user.ts";
import { RubyFloat } from "../../search/es-json.ts";

import { failure, isBlank, jsonRendered, paramToS, timeJson } from "./base.ts";
import { paginateWithCursor } from "./cursor.ts";
import { handBack } from "./hand-back.ts";
import { type PurchaseRow, serializePurchases } from "./purchases.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForRead, successPayload } from "./users.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
// Purchase.state_machines[:purchase_state].states, in declaration order (the 400 names them so)
const PURCHASE_STATES = [
  "in_progress",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "test_successful",
  "failed",
  "preorder_authorization_successful",
  "preorder_concluded_unsuccessfully",
  "test_preorder_successful",
  "gift_receiver_purchase_failed",
  "preorder_authorization_failed",
  "preorder_concluded_successfully",
];
const BOOLEAN_FILTERS = ["chargedback", "has_early_fraud_warning", "has_affiliate"] as const;
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);
// Admin::RelatedUsersService
const VALID_SIGNALS = ["ip", "payment_address", "card_fingerprint"];
const IP_COLUMNS = ["account_created_ip", "current_sign_in_ip", "last_sign_in_ip"] as const;
const RELATED_MAX_LIMIT = 50;
const RISK_STATE_COMMENT_TYPES = ["compliant", "not_reviewed", "on", "flagged", "suspended"];
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
const FLAGGED_STATES = ["flagged_for_tos_violation", "flagged_for_fraud"];
// Radar::SellerRiskStatsService::LOOKBACK_PERIOD
const RADAR_LOOKBACK_MS = 90 * 86_400_000;
const ELEVATED_RISK = "elevated";
const HIGHEST_RISK = "highest";
const PERCENT = 100;
const RATE_DIGITS = 2;
const SOCIAL_FUNNEL_OFFERED_EVENT = "social_connect_offered";
// Ruby and JavaScript print a float in plain notation between these bounds and in exponent notation outside them.
const MIN_PLAIN_FRACTION = 1e-4;
const MAX_PLAIN_FRACTION = 1e15;

// ActiveModel::Type::Boolean#cast
function castBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && !Number.isInteger(value))
    throw new NotPortedError("a fractional boolean parameter", SOURCE);
  if (value === false || value === 0) return false;
  return !(typeof value === "string" && FALSE_VALUES.has(value));
}

// Time.xmlschema: case-insensitive T and Z, a zone of +hh, +hhmm or +hh:mm (UTC when absent), any number of fraction digits.
const ISO_TIMESTAMP =
  /^[ \t\r\n\f\v]*(-?\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)?[ \t\r\n\f\v]*$/iu;
const SECONDS_PER_DAY = 86_400;
// The comparison literal is read as is by MySQL, which accepts a year below its DATETIME floor of 1000; only year 998 is recorded, so the
// two-digit years Date.UTC maps to 19xx and everything below 100 stay with Rails.
const MIN_SQL_YEAR = 100;
const MAX_SQL_YEAR = 9999;
const MICROSECOND_DIGITS = 6;

// Time.iso8601(value.to_s) rescued to nil. Ruby rolls a day past the end of the month (Feb 30) and 24:00:00 or a leap second into the
// next unit, as Date.UTC does; every other out-of-range part raises.
export function parseIso8601(value: unknown): { sql: string } | null {
  const match = ISO_TIMESTAMP.exec(paramToS(value, SOURCE));
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match as unknown as string[];
  const [mo, d, h, mi, s] = [month, day, hour, minute, second].map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60 || (h === 24 && (mi > 0 || s > 0)))
    return null;
  let offset = 0;
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const [zh, zm] = [Number(digits.slice(0, 2)), Number(digits.slice(2) || "0")];
    if (zh >= 24) return null;
    if (zm > 59) throw new NotPortedError("a zone with minutes past 59", SOURCE);
    offset = (zone.startsWith("-") ? -1 : 1) * (zh * 3600 + zm * 60);
    if (Math.abs(offset) >= SECONDS_PER_DAY) return null;
  }
  if (!/^\d{4}$/u.test(year!)) throw new NotPortedError("a year that is not four digits", SOURCE);
  if (Number(year) < MIN_SQL_YEAR) throw new NotPortedError("a year outside 100-9999", SOURCE);
  const instant = new Date(Date.UTC(Number(year), mo - 1, d, h, mi, s) - offset * 1000);
  if (instant.getUTCFullYear() < MIN_SQL_YEAR || instant.getUTCFullYear() > MAX_SQL_YEAR)
    throw new NotPortedError("a year outside 100-9999", SOURCE);
  const stamp = instant.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  return { sql: `${stamp}.${fraction.slice(0, MICROSECOND_DIGITS).padEnd(MICROSECOND_DIGITS, "0")}` };
}

type Filters = {
  states?: string[];
  start?: string;
  end?: string;
  booleans: Partial<Record<(typeof BOOLEAN_FILTERS)[number], boolean>>;
  fingerprint?: string;
  ip?: string;
};

// parse_purchases_filters: the filters, or the refusal.
function parsePurchasesFilters(
  params: Record<string, unknown>,
): { filters: Filters } | { refusal: ReturnType<typeof failure> } {
  const filters: Filters = { booleans: {} };
  if (!isBlank(params.status)) {
    const raw = params.status;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw))
      throw new NotPortedError("a status that is a hash", SOURCE);
    const items = Array.isArray(raw) ? raw : [raw];
    const states = items
      .flatMap((item) => paramToS(item, SOURCE).split(","))
      .map((state) => rubyStrip(state))
      .filter((state) => !isBlank(state));
    if (states.length === 0 || states.some((state) => !PURCHASE_STATES.includes(state)))
      return { refusal: failure(`status must be one of: ${PURCHASE_STATES.join(", ")}`, 400) };
    filters.states = states;
  }
  for (const [name, key] of [
    ["start_at", "start"],
    ["end_at", "end"],
  ] as const) {
    if (isBlank(params[name])) continue;
    const parsed = parseIso8601(params[name]);
    if (parsed === null) return { refusal: failure(`${name} must be a valid ISO 8601 timestamp`, 400) };
    filters[key] = parsed.sql;
  }
  for (const key of BOOLEAN_FILTERS) {
    if (!(key in params)) continue;
    const casted = castBoolean(params[key]);
    if (casted === null) return { refusal: failure(`${key} must be true or false`, 400) };
    filters.booleans[key] = casted;
  }
  if (!isBlank(params.stripe_fingerprint)) filters.fingerprint = paramToS(params.stripe_fingerprint, SOURCE);
  if (!isBlank(params.ip_address)) filters.ip = paramToS(params.ip_address, SOURCE);
  return { filters };
}

const risk = (state: string | null, lastChangedAt: Date | null) => {
  const suspended = state !== null && SUSPENDED_STATES.includes(state);
  const flagged = state !== null && FLAGGED_STATES.includes(state);
  return {
    status: suspended ? "Suspended" : flagged ? "Flagged" : "Compliant",
    user_risk_state: state,
    suspended,
    flagged_for_fraud: state === "flagged_for_fraud",
    flagged_for_tos_violation: state === "flagged_for_tos_violation",
    on_probation: state === "on_probation",
    compliant: state === "compliant",
    last_status_changed_at: timeJson(lastChangedAt),
  };
};

// Integer(value, exception: false): null when Ruby would not read a whole number.
function rubyInteger(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) throw new NotPortedError("a fractional limit", SOURCE);
    return raw;
  }
  if (typeof raw !== "string") return null;
  // Only hexadecimal is recorded; binary, octal, a bare leading zero and underscores inside a prefixed number stay with Rails.
  const hex = /^\s*([+-]?)0[xX]([0-9a-fA-F]+)\s*$/u.exec(raw);
  if (hex !== null) return Number.parseInt(`${hex[1]}${hex[2]}`, 16);
  if (/^\s*[+-]?0[0-9xXbBoO_]/u.test(raw)) throw new NotPortedError("a limit in another base", SOURCE);
  return /^\s*[+-]?\d+(?:_\d+)*\s*$/u.test(raw) ? Number.parseInt(raw.replaceAll("_", ""), 10) : null;
}

// `signals` is JSON whose floats Node cannot tell from integers (1.0 and 1 parse alike), so only an object of plain fractions, which
// both languages print the same way, is served; anything else stays with Rails.
function fractionalSignals(raw: unknown): Record<string, number> {
  const plain = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const entries = plain ? Object.entries(raw) : [];
  if (
    !plain ||
    entries.length === 0 ||
    !entries.every(
      ([, value]) =>
        typeof value === "number" &&
        !Number.isInteger(value) &&
        Math.abs(value) >= MIN_PLAIN_FRACTION &&
        Math.abs(value) < MAX_PLAIN_FRACTION,
    )
  )
    throw new NotPortedError("a shadow evaluation with signals other than plain fractions", SOURCE);
  return Object.fromEntries(entries) as Record<string, number>;
}

type RelatedUserRow = {
  id: bigint;
  account_created_ip: string | null;
  current_sign_in_ip: string | null;
  last_sign_in_ip: string | null;
};
type Relation = { user_id: bigint; signal: string; shared_value: string | null; via: string[] | null };

async function relatedUsers(
  target: {
    id: bigint;
    account_created_ip: string | null;
    current_sign_in_ip: string | null;
    last_sign_in_ip: string | null;
    payment_address: string | null;
    credit_card_id: bigint | null;
  },
  signals: string[],
  limit: number,
) {
  const evaluated: string[] = [];
  const truncated: Record<string, boolean> = {};
  const relations: Relation[] = [];
  const present = (value: string | null): value is string => value !== null && !isBlank(value);

  if (signals.includes("ip")) {
    const byValue = new Map<string, string[]>();
    for (const column of IP_COLUMNS) {
      const value = target[column];
      if (present(value)) byValue.set(value, [...(byValue.get(value) ?? []), column]);
    }
    const ips = [...byValue.keys()];
    if (ips.length > 0) evaluated.push("ip");
    let overflow = false;
    if (ips.length > 0) {
      const rows = await db.$queryRaw<
        RelatedUserRow[]
      >`SELECT id, account_created_ip, current_sign_in_ip, last_sign_in_ip FROM users WHERE (account_created_ip IN (${Prisma.join(ips)}) OR current_sign_in_ip IN (${Prisma.join(ips)}) OR last_sign_in_ip IN (${Prisma.join(ips)})) AND id != ${target.id} ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1}`;
      overflow = rows.length > limit;
      const grouped = new Map<string, { user_id: bigint; value: string; via: string[] }>();
      for (const row of rows.slice(0, limit)) {
        for (const column of IP_COLUMNS) {
          const value = row[column];
          if (value === null || !byValue.has(value)) continue;
          const key = `${row.id}\u0000${value}`;
          const relation = grouped.get(key) ?? { user_id: row.id, value, via: [] };
          grouped.set(key, relation);
          relation.via.push(...byValue.get(value)!, column);
        }
      }
      for (const relation of grouped.values()) {
        const via = [...new Set(relation.via)].sort(
          (a, b) =>
            IP_COLUMNS.indexOf(a as (typeof IP_COLUMNS)[number]) - IP_COLUMNS.indexOf(b as (typeof IP_COLUMNS)[number]),
        );
        relations.push({ user_id: relation.user_id, signal: "ip", shared_value: relation.value, via });
      }
    }
    truncated.ip = overflow;
  }

  if (signals.includes("payment_address")) {
    if (present(target.payment_address)) {
      evaluated.push("payment_address");
      const rows = await db.$queryRaw<
        { id: bigint }[]
      >`SELECT id FROM users WHERE payment_address = ${target.payment_address} AND id != ${target.id} ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1}`;
      for (const row of rows.slice(0, limit))
        relations.push({ user_id: row.id, signal: "payment_address", shared_value: target.payment_address, via: null });
      truncated.payment_address = rows.length > limit;
    } else truncated.payment_address = false;
  }

  if (signals.includes("card_fingerprint")) {
    const card =
      target.credit_card_id === null
        ? null
        : await db.creditCard.findFirst({
            where: { id: Number(target.credit_card_id) },
            select: { stripe_fingerprint: true },
          });
    const fingerprint = card?.stripe_fingerprint ?? null;
    if (present(fingerprint)) {
      evaluated.push("card_fingerprint");
      const rows = await db.$queryRaw<
        { id: bigint }[]
      >`SELECT users.id FROM users INNER JOIN credit_cards ON credit_cards.id = users.credit_card_id WHERE credit_cards.stripe_fingerprint = ${fingerprint} AND users.id != ${target.id} ORDER BY users.updated_at DESC, users.id DESC LIMIT ${limit + 1}`;
      for (const row of rows.slice(0, limit))
        relations.push({ user_id: row.id, signal: "card_fingerprint", shared_value: null, via: null });
      truncated.card_fingerprint = rows.length > limit;
    } else truncated.card_fingerprint = false;
  }
  return { evaluated, truncated, relations };
}

async function rankRelated(relations: Relation[]) {
  const byUser = new Map<bigint, Relation[]>();
  for (const relation of relations) byUser.set(relation.user_id, [...(byUser.get(relation.user_id) ?? []), relation]);
  if (byUser.size === 0) return [];
  const userIds = [...byUser.keys()];
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      external_id: true,
      email: true,
      name: true,
      deleted_at: true,
      user_risk_state: true,
      updated_at: true,
    },
  });
  const changed = await db.comment.groupBy({
    by: ["commentable_id"],
    where: {
      commentable_type: "User",
      commentable_id: { in: userIds },
      comment_type: { in: RISK_STATE_COMMENT_TYPES },
    },
    _max: { created_at: true },
  });
  const changedAt = new Map(changed.map((row) => [row.commentable_id, row._max.created_at]));
  const epoch = (time: Date | null) => Math.floor((time?.getTime() ?? 0) / 1000);
  const signalCount = (id: bigint) => new Set(byUser.get(id)!.map((relation) => relation.signal)).size;
  return users
    .sort(
      (a, b) =>
        signalCount(b.id) - signalCount(a.id) ||
        epoch(b.updated_at) - epoch(a.updated_at) ||
        (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
    )
    .map((user) => ({
      id: user.external_id,
      email: user.email,
      name: user.name,
      deleted_at: timeJson(user.deleted_at),
      risk_state: risk(user.user_risk_state, changedAt.get(user.id) ?? null),
      relations: byUser.get(user.id)!.map((relation) => ({
        signal: relation.signal,
        shared_value: relation.shared_value,
        ...(relation.via !== null && relation.via.length > 0 ? { via: relation.via } : {}),
      })),
    }));
}

const iso = (time: Date | null) => timeJson(time);

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/users/purchases",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const parsed = parsePurchasesFilters(admin.params);
      if ("refusal" in parsed) return parsed.refusal;
      const filter = parsed.filters;
      const [row] = await db.$queryRaw<
        { email: string | null }[]
      >`SELECT email FROM users WHERE id = ${user.id} LIMIT 1`;
      const owner =
        row?.email === null || row === undefined || isBlank(row.email)
          ? Prisma.sql`\`purchases\`.\`purchaser_id\` = ${user.id}`
          : Prisma.sql`(\`purchases\`.\`purchaser_id\` = ${user.id} OR \`purchases\`.\`email\` = ${row.email})`;
      const conditions: Prisma.Sql[] = [owner];
      if (filter.states)
        conditions.push(Prisma.sql`\`purchases\`.\`purchase_state\` IN (${Prisma.join(filter.states)})`);
      if (filter.start) conditions.push(Prisma.sql`purchases.created_at >= ${filter.start}`);
      if (filter.end) conditions.push(Prisma.sql`purchases.created_at <= ${filter.end}`);
      const { chargedback, has_early_fraud_warning: efw, has_affiliate: affiliate } = filter.booleans;
      if (chargedback !== undefined)
        conditions.push(
          chargedback
            ? Prisma.sql`\`purchases\`.\`chargeback_date\` IS NOT NULL`
            : Prisma.sql`\`purchases\`.\`chargeback_date\` IS NULL`,
        );
      if (efw !== undefined)
        conditions.push(
          Prisma.sql`${efw ? Prisma.sql`EXISTS` : Prisma.sql`NOT EXISTS`} (SELECT 1 FROM purchase_early_fraud_warnings WHERE purchase_early_fraud_warnings.purchase_id = purchases.id)`,
        );
      if (affiliate !== undefined)
        conditions.push(
          affiliate
            ? Prisma.sql`\`purchases\`.\`affiliate_id\` IS NOT NULL`
            : Prisma.sql`\`purchases\`.\`affiliate_id\` IS NULL`,
        );
      if (filter.fingerprint) conditions.push(Prisma.sql`\`purchases\`.\`stripe_fingerprint\` = ${filter.fingerprint}`);
      if (filter.ip) conditions.push(Prisma.sql`\`purchases\`.\`ip_address\` = ${filter.ip}`);
      const page = await paginateWithCursor<PurchaseRow & { created_at_iso: string }>(
        "purchases",
        Prisma.join(conditions, " AND "),
        admin.params,
        Prisma.raw("`purchases`.*"),
      );
      if ("invalid" in page) return page.invalid;
      // purchasesAsJsonV2 reads the seller of every row.
      if (page.rows.some((row) => row.seller_id === null))
        throw new NotPortedError("a purchase without a seller", SOURCE);
      return jsonRendered(
        successPayload(user, { purchases: await serializePurchases(page.rows), pagination: page.pagination }),
      );
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/related",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const rawSignals = admin.params.signals;
      let signals = VALID_SIGNALS;
      const text = paramToS(rawSignals, SOURCE);
      if (!isBlank(text)) {
        const values = [
          ...new Set(
            text
              .split(",")
              .map((value) => rubyStrip(value))
              .filter((value) => !isBlank(value)),
          ),
        ];
        const invalid = values.filter((value) => !VALID_SIGNALS.includes(value));
        if (values.length === 0 || invalid.length > 0)
          return failure(`signals contains invalid value: ${invalid[0] ?? text}`, 400);
        signals = values;
      }
      const requested = rubyInteger(admin.params.limit);
      const limit = requested === null || requested <= 0 ? RELATED_MAX_LIMIT : Math.min(requested, RELATED_MAX_LIMIT);
      const target = await db.user.findFirstOrThrow({
        where: { id: user.id },
        select: {
          id: true,
          account_created_ip: true,
          current_sign_in_ip: true,
          last_sign_in_ip: true,
          payment_address: true,
          credit_card_id: true,
        },
      });
      const result = await relatedUsers(target, signals, limit);
      return jsonRendered(
        successPayload(user, {
          signals_evaluated: result.evaluated,
          per_signal_limit: limit,
          related_users: await rankRelated(result.relations),
          truncated: result.truncated,
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/social_connections",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      // record_reviewed! writes a funnel event once an offer was recorded for the user.
      const offered = await db.event.findFirst({
        where: { user_id: Number(user.id), event_name: SOCIAL_FUNNEL_OFFERED_EVENT },
        select: { id: true },
      });
      if (offered !== null) return handBack("the social connect funnel review event", SOURCE);
      const verifications = await db.$queryRaw<
        {
          id: bigint;
          platform: string;
          uid: string;
          handle: string | null;
          account_created_at: Date | null;
          follower_count: bigint | null;
          post_count: bigint | null;
          last_posted_at: Date | null;
          last_verified_at: Date;
          superseded_at: Date | null;
        }[]
      >`SELECT * FROM social_connect_verifications WHERE user_id = ${user.id} ORDER BY platform, superseded_at IS NOT NULL, last_verified_at DESC`;
      // currently_linked? reads the YouTube, Instagram and TikTok identity tables.
      if (verifications.some((row) => row.platform !== "twitter"))
        throw new NotPortedError("a social connection that is not Twitter", SOURCE);
      const [twitter] = await db.$queryRaw<
        { twitter_user_id: string | null }[]
      >`SELECT twitter_user_id FROM users WHERE id = ${user.id} LIMIT 1`;
      const shadow = await db.socialScoreShadowEvaluation.findFirst({
        where: { user_id: user.id },
        orderBy: [{ evaluated_on: "desc" }, { id: "desc" }],
      });
      const signals =
        shadow?.signals === undefined || shadow.signals === null ? null : fractionalSignals(shadow.signals);
      const connections = [];
      for (const row of verifications) {
        const shared = await db.socialConnectVerification.count({
          where: { platform: row.platform, uid: row.uid, user_id: { not: user.id } },
        });
        const linked =
          row.superseded_at === null &&
          !isBlank(twitter?.twitter_user_id) &&
          String(twitter!.twitter_user_id) === row.uid;
        connections.push({
          platform: row.platform,
          uid: row.uid,
          handle: row.handle,
          currently_linked: linked,
          account_created_at: iso(row.account_created_at),
          follower_count: row.follower_count === null ? null : Number(row.follower_count),
          post_count: row.post_count === null ? null : Number(row.post_count),
          last_posted_at: iso(row.last_posted_at),
          last_verified_at: iso(row.last_verified_at),
          superseded_at: iso(row.superseded_at),
          shared_identity_user_count: shared,
        });
      }
      const latest =
        shadow === null
          ? null
          : {
              mode: "historical_shadow",
              notice: "Stored shadow evidence only; not current eligibility or payout authorization.",
              evaluated_on: shadow.evaluated_on.toISOString().slice(0, 10),
              recorded_at: iso(shadow.created_at),
              score: shadow.score,
              unpaid_balance_cents: Number(shadow.unpaid_balance_cents),
              would_have_released: shadow.would_have_released,
              hold_source: shadow.hold_source,
              signals,
            };
      return jsonRendered(successPayload(user, { social_connections: connections, latest_shadow_evaluation: latest }));
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/radar_stats",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const cutoff = new Date(Date.now() - RADAR_LOOKBACK_MS).toISOString().replace("T", " ").replace("Z", "");
      const efws = Prisma.sql`(purchase_early_fraud_warnings.id IN (SELECT purchase_early_fraud_warnings.id FROM purchase_early_fraud_warnings INNER JOIN purchases ON purchases.id = purchase_early_fraud_warnings.purchase_id WHERE purchases.seller_id = ${user.id}) OR purchase_early_fraud_warnings.id IN (SELECT purchase_early_fraud_warnings.id FROM purchase_early_fraud_warnings INNER JOIN charges ON charges.id = purchase_early_fraud_warnings.charge_id WHERE charges.seller_id = ${user.id})) AND purchase_early_fraud_warnings.created_at >= ${cutoff}`;
      const [successful] = await db.$queryRaw<
        { count: bigint }[]
      >`SELECT COUNT(*) AS count FROM purchases WHERE purchases.seller_id = ${user.id} AND purchases.purchase_state = 'successful' AND COALESCE(purchases.charge_processor_id, '') != 'paypal' AND purchases.created_at >= ${cutoff}`;
      const groups = await db.$queryRaw<
        { charge_risk_level: string | null; fraud_type: string | null; count: bigint }[]
      >`SELECT purchase_early_fraud_warnings.charge_risk_level, purchase_early_fraud_warnings.fraud_type, COUNT(*) AS count FROM purchase_early_fraud_warnings WHERE ${efws} GROUP BY purchase_early_fraud_warnings.charge_risk_level, purchase_early_fraud_warnings.fraud_type`;
      // The order a GROUP BY returns its groups in is the database's, and the stats hash keeps it.
      if (groups.length > 1) throw new NotPortedError("more than one early fraud warning group", SOURCE);
      const [disputes] = await db.$queryRaw<
        { count: bigint }[]
      >`SELECT COUNT(*) AS count FROM disputes LEFT OUTER JOIN purchases ON purchases.id = disputes.purchase_id LEFT OUTER JOIN charges ON charges.id = disputes.charge_id WHERE COALESCE(purchases.charge_processor_id, charges.processor, '') != 'paypal' AND disputes.seller_id = ${user.id} AND disputes.state != 'won' AND disputes.created_at >= ${cutoff}`;
      const successfulCount = Number(successful!.count);
      const disputeCount = Number(disputes!.count);
      const efwTotal = groups.reduce((sum, row) => sum + Number(row.count), 0);
      const byType: Record<string, number> = {};
      for (const row of groups) byType[row.fraud_type ?? ""] = (byType[row.fraud_type ?? ""] ?? 0) + Number(row.count);
      const countAt = (level: string) =>
        groups.reduce((sum, row) => sum + (row.charge_risk_level === level ? Number(row.count) : 0), 0);
      const rate =
        successfulCount === 0 ? 0 : rubyFloatRoundDigits((disputeCount / successfulCount) * PERCENT, RATE_DIGITS);

      const page = await paginateWithCursor<{
        id: bigint;
        created_at_iso: string;
        purchase_id: bigint | null;
        charge_id: bigint | null;
        fraud_type: string | null;
        charge_risk_level: string | null;
        resolution: string | null;
        created_at: Date;
      }>(
        "purchase_early_fraud_warnings",
        efws,
        admin.params,
        Prisma.raw(
          "`purchase_early_fraud_warnings`.`id`, `purchase_early_fraud_warnings`.`purchase_id`, `purchase_early_fraud_warnings`.`charge_id`, `purchase_early_fraud_warnings`.`fraud_type`, `purchase_early_fraud_warnings`.`charge_risk_level`, `purchase_early_fraud_warnings`.`resolution`, `purchase_early_fraud_warnings`.`created_at`",
        ),
      );
      if ("invalid" in page) return page.invalid;
      const purchaseIds = page.rows.map((row) => row.purchase_id).filter((id): id is bigint => id !== null);
      const existingPurchases =
        purchaseIds.length === 0
          ? []
          : await db.purchase.findMany({ where: { id: { in: purchaseIds } }, select: { id: true } });
      const chargeIds = page.rows.map((row) => row.charge_id).filter((id): id is bigint => id !== null);
      const existingCharges =
        chargeIds.length === 0
          ? []
          : await db.charge.findMany({ where: { id: { in: chargeIds } }, select: { id: true } });
      const recent = page.rows.map((row) => ({
        purchase_id:
          row.purchase_id !== null && existingPurchases.some((purchase) => purchase.id === row.purchase_id)
            ? encrypt(row.purchase_id)
            : row.charge_id !== null && existingCharges.some((charge) => charge.id === row.charge_id)
              ? `CH-${encrypt(row.charge_id)}`
              : null,
        fraud_type: row.fraud_type,
        charge_risk_level: row.charge_risk_level,
        resolution: row.resolution,
        created_at: timeJson(row.created_at),
      }));
      return jsonRendered(
        successPayload(user, {
          radar_stats: {
            successful_purchases: successfulCount,
            efw_count: efwTotal,
            efw_by_fraud_type: byType,
            efw_with_elevated_risk: countAt(ELEVATED_RISK),
            efw_with_highest_risk: countAt(HIGHEST_RISK),
            dispute_count: disputeCount,
            dispute_rate: new RubyFloat(rate),
          },
          recent_efws: recent,
          pagination: page.pagination,
        }),
      );
    },
  },
);
