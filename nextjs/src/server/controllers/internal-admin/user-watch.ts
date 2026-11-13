// Api::Internal::Admin::UsersController#watch, #update_watch and #unwatch: the watchlist (WatchedUser). Creating a watch hands back to
// Rails because WatchedUser#sync! recomputes the seller's revenue and unpaid balance from the sales tables.
import type { WatchedUser } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank, jsonRendered, paramToS, recordAdminWrite } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite } from "./user-writes.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
const WRAPPER = { key: "user", model: "User" };
const THRESHOLD_REQUIRED_MESSAGE = "revenue_threshold is required";
const THRESHOLD_INVALID_MESSAGE = "revenue_threshold must be a positive number";
const NOT_WATCHED_MESSAGE = "User is not currently being watched";
const DECIMAL = /^[+-]?(\d+)(?:\.(\d+))?$/u;
// Whole-number mantissa and a plain exponent: the shape the recording covers. Signed or fractional parts stay with Rails.
const WHOLE_EXPONENT = /^(\d+)[eE](\d+)$/u;
const MAX_EXPONENT_DIGITS = 2;
const NON_FINITE = /^[+-]?(?:Infinity|NaN)$/u;
const CENTS_PER_UNIT = 100n;
const ROUND_HALF_UP_DIGIT = 5;
// A threshold beyond the bigint column raises in Rails; the exact failure is not worth reproducing.
const MAX_THRESHOLD_CENTS = 2n ** 62n;

const iso8601 = (time: Date | null): string | null => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

// parse_threshold_cents: `(BigDecimal(raw.to_s) * 100).round`, nil unless finite and positive. Shapes BigDecimal() reads in
// other ways (signed or fractional exponents, underscores, padding, a trailing dot) are handed back rather than guessed at.
export function parseThresholdCents(raw: unknown): bigint | null {
  const text = paramToS(raw, SOURCE);
  if (NON_FINITE.test(text)) return null;
  const exponent = WHOLE_EXPONENT.exec(text);
  if (exponent !== null && exponent[2]!.length <= MAX_EXPONENT_DIGITS) {
    const cents = BigInt(exponent[1]!) * 10n ** BigInt(exponent[2]!) * CENTS_PER_UNIT;
    if (cents > MAX_THRESHOLD_CENTS) throw new NotPortedError("a revenue_threshold past the column's range", SOURCE);
    return cents > 0n ? cents : null;
  }
  const match = DECIMAL.exec(text);
  if (match === null) {
    if (/^[A-Za-z]+$/u.test(text)) return null;
    throw new NotPortedError("a revenue_threshold BigDecimal() reads in another way", SOURCE);
  }
  const fraction = match[2] ?? "";
  let cents = BigInt(match[1]!) * CENTS_PER_UNIT + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (fraction.length > 2 && Number(fraction[2]) >= ROUND_HALF_UP_DIGIT) cents += 1n;
  if (text.startsWith("-")) cents = -cents;
  if (cents > MAX_THRESHOLD_CENTS) throw new NotPortedError("a revenue_threshold past the column's range", SOURCE);
  return cents > 0n ? cents : null;
}

// `params[:notes].presence`; anything but text is cast by ActiveRecord in ways Node does not model.
export function notesParam(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new NotPortedError("notes that is not a string", SOURCE);
  return isBlank(raw) ? null : raw;
}

export function serializeWatchedUser(watched: WatchedUser) {
  return {
    id: encrypt(watched.id),
    revenue_threshold_cents: Number(watched.revenue_threshold_cents),
    revenue_cents: Number(watched.revenue_cents),
    unpaid_balance_cents: Number(watched.unpaid_balance_cents),
    notes: watched.notes,
    created_at: iso8601(watched.created_at),
    last_synced_at: iso8601(watched.last_synced_at),
  };
}

export const activeWatch = (userId: bigint) =>
  db.watchedUser.findFirst({ where: { user_id: userId, deleted_at: null }, orderBy: { id: "asc" } });

defineAdminRoute(
  {
    method: "POST",
    pattern: "/internal/admin/users/watch",
    run: async (admin) => {
      if (isBlank(admin.params.revenue_threshold)) return failure(THRESHOLD_REQUIRED_MESSAGE, 400);
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      return recordAdminWrite(
        admin,
        {
          action: "users.watch",
          target: { type: "User", id: user.id, externalId: user.external_id },
          wrapper: WRAPPER,
        },
        async () => {
          if (parseThresholdCents(admin.params.revenue_threshold) === null)
            return failure(THRESHOLD_INVALID_MESSAGE, 400);
          if ((await activeWatch(user.id)) !== null) return failure("User is already being watched", 422);
          throw new NotPortedError("a new watch (WatchedUser#sync! recomputes revenue and unpaid balance)", SOURCE);
        },
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/update_watch",
    run: async (admin) => {
      if (isBlank(admin.params.revenue_threshold)) return failure(THRESHOLD_REQUIRED_MESSAGE, 400);
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      return recordAdminWrite(
        admin,
        {
          action: "users.update_watch",
          target: { type: "User", id: user.id, externalId: user.external_id },
          wrapper: WRAPPER,
        },
        async () => {
          const threshold = parseThresholdCents(admin.params.revenue_threshold);
          if (threshold === null) return failure(THRESHOLD_INVALID_MESSAGE, 400);
          const watched = await activeWatch(user.id);
          if (watched === null) return failure(NOT_WATCHED_MESSAGE, 422);
          const notes = "notes" in admin.params ? notesParam(admin.params.notes) : watched.notes;
          // An update that changes nothing writes nothing, updated_at included.
          const changed = watched.revenue_threshold_cents !== threshold || watched.notes !== notes;
          const saved = changed
            ? await db.watchedUser.update({
                where: { id: watched.id },
                data: { revenue_threshold_cents: threshold, notes, updated_at: new Date() },
              })
            : watched;
          return jsonRendered({
            success: true,
            user_id: user.external_id,
            message: "Watchlist updated",
            watched_user: serializeWatchedUser(saved),
          });
        },
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/unwatch",
    run: async (admin) => {
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      return recordAdminWrite(
        admin,
        {
          action: "users.unwatch",
          target: { type: "User", id: user.id, externalId: user.external_id },
          wrapper: WRAPPER,
        },
        async () => {
          const watched = await activeWatch(user.id);
          if (watched === null) return failure(NOT_WATCHED_MESSAGE, 422);
          const now = new Date();
          await db.watchedUser.update({ where: { id: watched.id }, data: { deleted_at: now, updated_at: now } });
          return jsonRendered({ success: true, user_id: user.external_id, message: "User removed from watchlist" });
        },
      );
    },
  },
);
