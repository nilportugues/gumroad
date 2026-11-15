// Api::Internal::Admin::UsersController: the writes that send mail, move a user through the risk state machine, queue a refund job or
// create a credit. Each answers its parameter and lookup refusals and the branches that change nothing (an account already in the
// state asked for, a refund whose expected figures are off), then hands the write back to Rails whole before the first change.
// The two-factor toggle and the risk transitions (mark compliant, suspend), with or without an admin note, run here.
import type { Comment } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { COMMENT_TYPES, Comments } from "../../models/comment.ts";
import { isStripeConnectAccount, STRIPE_CHARGE_PROCESSOR_ID } from "../../models/merchant-account.ts";
import { fetchOrBuildComplianceInfo, legalEntityCountryCode } from "../../models/user-compliance-info.ts";
import { fireRiskEventBang, InvalidTransition, SuspensionClearNotAuthorizedError } from "../../models/user-risk.ts";
import { findUserBang, NotPortedError, setFlag, Users } from "../../models/user.ts";
import { nativePayoutsSupported } from "../../page-props/signed-in/data.ts";

import { failure, isBlank, jsonRendered, paramToS, recordAdminWrite, type AdminRequest } from "./base.ts";
import { emailFormatValid } from "./email-format.ts";
import { handBack } from "./hand-back.ts";
import { idFromExternalId, textParam } from "./products.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite, toSentence, USER_ID_REQUIRED_MESSAGE } from "./user-writes.ts";
import { unpaidBalanceSummary } from "./users-reads.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
const WRAPPER = { key: "user", model: "User" };
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);
const NON_NEGATIVE_INTEGER = /^\d+$/u;
const INTEGER = /^-?\d+$/u;

// internal_admin_user_success_payload
const ok = (user: Looked, payload: Record<string, unknown>) => ({
  success: true,
  user_id: user.external_id,
  ...payload,
});

type Looked = Extract<Awaited<ReturnType<typeof findUserForWrite>>, { user: unknown }>["user"];

const target = (user: Looked) => ({ type: "User", id: user.id, externalId: user.external_id });

// ActiveModel::Type::Boolean.new.cast(value) == true
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return false;
  if (typeof value === "number" && !Number.isInteger(value))
    throw new NotPortedError("a fractional boolean parameter", SOURCE);
  return !(typeof value === "string" && FALSE_VALUES.has(value));
}

// User#user_risk_state, read where the action reads it
async function riskState(user: Looked): Promise<string | null> {
  return (await db.user.findFirstOrThrow({ where: { id: user.id }, select: { user_risk_state: true } }))
    .user_risk_state;
}

// Run `check` inside record_admin_write: a Rendered answers (and is audited), null hands the request back.
const audited = (
  admin: AdminRequest,
  action: string,
  user: Looked,
  reason: string,
  check: () => Promise<ReturnType<typeof jsonRendered> | null>,
) =>
  recordAdminWrite(
    admin,
    { action, target: target(user), wrapper: WRAPPER },
    async () => (await check()) ?? handBack(reason, SOURCE),
  );

// find_internal_admin_user_for_write_or_render, then the block
const forUser =
  (
    action: string,
    reason: string,
    check: (user: Looked, admin: AdminRequest) => Promise<ReturnType<typeof jsonRendered> | null> = () =>
      Promise.resolve(null),
  ) =>
  async (admin: AdminRequest) => {
    const found = await findUserForWrite(admin, false);
    if ("refusal" in found) return found.refusal;
    return audited(admin, action, found.user, reason, () => check(found.user, admin));
  };

// parse_non_negative_integer_param: the figure, or the refusal
function nonNegativeInteger(
  admin: AdminRequest,
  name: string,
): { value: bigint } | { refusal: ReturnType<typeof failure> } {
  const raw = admin.params[name];
  if (isBlank(raw)) return { refusal: failure(`${name} is required`, 400) };
  const text = paramToS(raw, SOURCE);
  return NON_NEGATIVE_INTEGER.test(text)
    ? { value: BigInt(text) }
    : { refusal: failure(`${name} must be a non-negative integer`, 400) };
}

const casefold = (value: string) => value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

const alreadySuspended = (state: string, message: string) => (user: Looked) =>
  riskState(user).then((current) =>
    current === state ? jsonRendered(ok(user, { status: "already_suspended", message })) : null,
  );

// The admin note rides beside the transition: Rails builds it on `user.comments` and answers 422 for an invalid one before anything is
// written. The transition's save autosaves it, so it is inserted ahead of the comment the transition writes after it. A verified
// account halts a suspension inside the transition, which answers 422 like any other InvalidTransition.
async function riskTransition(
  user: Looked,
  admin: AdminRequest,
  event: "mark_compliant" | "suspend_for_fraud" | "suspend_for_tos_violation",
  noteParam: string,
  params: { clear_suspension?: boolean },
  answer: Record<string, unknown>,
) {
  const content = admin.params[noteParam];
  if (!isBlank(content) && typeof content !== "string") await handBack("an admin note that is not text", SOURCE);
  const note = isBlank(content)
    ? null
    : Comments.build({
        commentable_id: user.id,
        commentable_type: "User",
        comment_type: noteParam === "note" ? COMMENT_TYPES.NOTE : COMMENT_TYPES.SUSPENSION_NOTE,
        author_id: admin.admin.actor.id,
        content: content as string,
      } as Partial<Comment>);
  if (note !== null && !(await Comments.valid(note))) return failure(toSentence(note.errors.fullMessages()), 422);
  const record = await findUserBang(user.id);
  try {
    await fireRiskEventBang(
      record,
      event,
      { author_id: admin.admin.actor.id, ...params },
      note === null ? {} : { afterSave: () => Comments.saveBang(note) },
    );
  } catch (error) {
    if (error instanceof InvalidTransition) return failure(error.message, 422);
    if (error instanceof SuspensionClearNotAuthorizedError) return failure(error.message, 409);
    throw error;
  }
  return jsonRendered(ok(user, answer));
}

const RESTORE_REFUSALS = {
  rail_recreatable: "This seller can add a bank account themselves; no restore needed",
  bank_account_already_active: "User already has an active bank account",
  no_deleted_bank_account: "No removed bank account to restore",
  no_deleted_merchant_account: "No removed Stripe account matches the bank account",
  retired_by_adoption:
    "The bank rail was removed when a Google or Apple sign-in took over the account, so it cannot be restored",
  incompatible_bank_rail: "The removed bank rail does not match the seller's current country",
} as const;

const CARD_BANK_ACCOUNT = "CardBankAccount";

// The refusals RestoreBankPayoutRail#process reaches before it asks Stripe about the account, or null when the request would get that
// far. The country check also compares the bank account's own country (a per-class constant), so it refuses only where the merchant
// account already differs or the seller has none, and hands the rest back whole.
async function restoreRefusal(userId: bigint): Promise<string | null> {
  const info = await fetchOrBuildComplianceInfo(userId);
  const country = info.persisted ? legalEntityCountryCode(info.row) : null;
  // User#can_create_bank_payout_rail?
  if ((nativePayoutsSupported(info.persisted ? info.row : null) && country !== "IN") || country === "AE")
    return RESTORE_REFUSALS.rail_recreatable;
  if ((await db.bankAccount.count({ where: { user_id: Number(userId), deleted_at: null } })) > 0)
    return RESTORE_REFUSALS.bank_account_already_active;
  const bank = await db.bankAccount.findFirst({
    where: { user_id: Number(userId), deleted_at: { not: null }, NOT: { type: CARD_BANK_ACCOUNT } },
    orderBy: { deleted_at: "desc" },
    select: { stripe_connect_account_id: true },
  });
  if (bank === null) return RESTORE_REFUSALS.no_deleted_bank_account;
  const merchantAccounts =
    bank.stripe_connect_account_id === null
      ? []
      : await db.merchantAccount.findMany({
          where: {
            user_id: userId,
            deleted_at: { not: null },
            charge_processor_id: STRIPE_CHARGE_PROCESSOR_ID,
            charge_processor_merchant_id: bank.stripe_connect_account_id,
          },
          orderBy: { id: "asc" },
        });
  const merchant = merchantAccounts.find((account) => !isStripeConnectAccount(account));
  if (merchant === undefined || isBlank(merchant.charge_processor_merchant_id))
    return RESTORE_REFUSALS.no_deleted_merchant_account;
  if (retiredByAdoption(merchant.json_data)) return RESTORE_REFUSALS.retired_by_adoption;
  if (isBlank(country) || merchant.country !== country) return RESTORE_REFUSALS.incompatible_bank_rail;
  return null;
}

// MerchantAccount#retired_by_adoption?
function retiredByAdoption(jsonData: string | null): boolean {
  if (isBlank(jsonData)) return false;
  const data: unknown = JSON.parse(jsonData!);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("json_data must be a hash");
  return !isBlank((data as Record<string, unknown>).retired_by_adoption_at);
}

const suspension = (
  event: "suspend_for_fraud" | "suspend_for_tos_violation",
  state: string,
  already: string,
  answer: Record<string, unknown>,
) => {
  const alreadyDone = alreadySuspended(state, already);
  return async (user: Looked, admin: AdminRequest) =>
    (await alreadyDone(user)) ?? riskTransition(user, admin, event, "suspension_note", {}, answer);
};

defineAdminRoute(
  {
    method: "POST",
    pattern: "/internal/admin/users/reset_password",
    run: forUser("users.reset_password", "a password reset mail"),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/update_email",
    run: async (admin) => {
      if (isBlank(admin.params.user_id)) return failure(USER_ID_REQUIRED_MESSAGE, 400);
      if (isBlank(admin.params.new_email)) return failure("new_email is required", 400);
      if (!emailFormatValid(textParam(admin.params.new_email))) return failure("Invalid new email format", 400);
      return forUser("users.update_email", "an email change", (user) =>
        Promise.resolve(
          casefold(user.email ?? "") === casefold(paramToS(admin.params.new_email, SOURCE))
            ? failure("New email is the same as the current email", 422)
            : null,
        ),
      )(admin);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/two_factor_authentication",
    run: async (admin) => {
      if (isBlank(paramToS(admin.params.enabled, SOURCE))) return failure("enabled is required", 400);
      return forUser("users.two_factor_authentication", "a two-factor change", async (user) => {
        const raw = admin.params.enabled;
        if (typeof raw !== "string" && typeof raw !== "boolean" && typeof raw !== "number")
          await handBack("a two-factor flag that is not a scalar", SOURCE);
        const enabled = truthy(raw);
        const record = await findUserBang(user.id);
        setFlag(record, "two_factor_authentication_enabled", enabled);
        // An account that fails validation answers 422 in Rails; nothing was written to get here.
        if (!(await Users.save(record))) await handBack("an account that fails validation", SOURCE);
        if (!enabled) await db.totpCredential.deleteMany({ where: { user_id: user.id } });
        return jsonRendered(
          ok(user, {
            message: `Two-factor authentication ${enabled ? "enabled" : "disabled"}`,
            two_factor_authentication_enabled: enabled,
          }),
        );
      })(admin);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/mark_compliant",
    run: forUser("users.mark_compliant", "a compliance change", async (user, admin) => {
      const state = await riskState(user);
      if (state === "compliant")
        return jsonRendered(ok(user, { status: "already_compliant", message: "User is already compliant" }));
      const clearSuspension = truthy(admin.params.clear_suspension);
      if (state !== null && SUSPENDED_STATES.includes(state) && !clearSuspension)
        return failure(`User is ${state}; pass clear_suspension=true to lift the suspension as well`, 422);
      return riskTransition(
        user,
        admin,
        "mark_compliant",
        "note",
        { clear_suspension: clearSuspension },
        { status: "marked_compliant", message: "User marked compliant" },
      );
    }),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/suspend_for_fraud",
    run: forUser(
      "users.suspend_for_fraud",
      "a fraud suspension",
      suspension("suspend_for_fraud", "suspended_for_fraud", "User is already suspended for fraud", {
        status: "suspended_for_fraud",
        message: "User suspended for fraud",
      }),
    ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/suspend_for_tos_violation",
    run: forUser(
      "users.suspend_for_tos_violation",
      "a policy suspension",
      suspension(
        "suspend_for_tos_violation",
        "suspended_for_tos_violation",
        "User is already suspended for a policy violation",
        { status: "suspended_for_tos_violation", message: "User suspended for a policy violation" },
      ),
    ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/flag_for_tos_violation",
    run: async (admin) => {
      if (isBlank(admin.params.product_id)) return failure("product_id is required", 400);
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const id = idFromExternalId(textParam(admin.params.product_id));
      const product =
        id === null
          ? null
          : await db.link.findFirst({
              where: { id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
              select: { user_id: true },
            });
      if (product === null) return failure("Product not found", 404);
      if (product.user_id !== found.user.id) return failure("Product does not belong to user", 422);
      return audited(admin, "users.flag_for_tos_violation", found.user, "a policy flag and product take-down", () =>
        Promise.resolve(null),
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/refund_all_for_fraud",
    run: async (admin) => {
      if (isBlank(admin.params.user_id)) return failure(USER_ID_REQUIRED_MESSAGE, 400);
      if (isBlank(admin.params.expected_email)) return failure("expected_email is required", 400);
      const count = nonNegativeInteger(admin, "expected_purchase_count");
      if ("refusal" in count) return count.refusal;
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const state = await riskState(found.user);
      if (state === null || !SUSPENDED_STATES.includes(state))
        return failure("User must be suspended to refund all purchases for fraud", 422);
      // The refundable purchases come from RefundAllForFraudWorker's scope, and the job is queued here.
      return audited(admin, "users.refund_all_for_fraud", found.user, "a fraud refund of every purchase", () =>
        Promise.resolve(null),
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/refund_balance",
    run: async (admin) => {
      if (isBlank(admin.params.user_id)) return failure(USER_ID_REQUIRED_MESSAGE, 400);
      if (isBlank(admin.params.expected_email)) return failure("expected_email is required", 400);
      const count = nonNegativeInteger(admin, "expected_purchase_count");
      if ("refusal" in count) return count.refusal;
      const total = nonNegativeInteger(admin, "expected_total_amount_cents");
      if ("refusal" in total) return total.refusal;
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const state = await riskState(found.user);
      if (state === null || !SUSPENDED_STATES.includes(state))
        return failure("User must be suspended to refund unpaid purchases", 422);
      const summary = await unpaidBalanceSummary(found.user.id);
      if (BigInt(summary.count) !== count.value || BigInt(summary.total) !== total.value)
        return jsonRendered(
          {
            ...ok(found.user, {}),
            success: false,
            message: "Expected unpaid balance does not match current unpaid balance",
            current: { count: summary.count, total: summary.total, total_amount_cents: summary.total, currency: "usd" },
          },
          409,
        );
      return audited(admin, "users.refund_balance", found.user, "a refund of the unpaid balance", () =>
        Promise.resolve(null),
      );
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/add_credit",
    run: async (admin) => {
      const found = await findUserForWrite(admin, false);
      if ("refusal" in found) return found.refusal;
      const raw = admin.params.amount_cents;
      if (isBlank(raw)) return failure("amount_cents is required", 400);
      const text = paramToS(raw, SOURCE);
      if (!INTEGER.test(text)) return failure("amount_cents must be an integer", 400);
      if (BigInt(text) === 0n) return failure("amount_cents must not be zero", 400);
      if (isBlank(rubyStrip(paramToS(admin.params.reason, SOURCE)))) return failure("reason is required", 400);
      return audited(admin, "users.add_credit", found.user, "a credit", () => Promise.resolve(null));
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/restore_bank_payout_rail",
    run: forUser("users.restore_bank_payout_rail", "a bank payout restore", async (user, admin) => {
      const content = admin.params.note;
      if (!isBlank(content) && typeof content !== "string") await handBack("an admin note that is not text", SOURCE);
      if (!isBlank(content)) {
        const note = Comments.build({
          commentable_id: user.id,
          commentable_type: "User",
          comment_type: COMMENT_TYPES.NOTE,
          author_id: admin.admin.actor.id,
          content: content as string,
        } as Partial<Comment>);
        if (!(await Comments.valid(note))) return failure(toSentence(note.errors.fullMessages()), 422);
      }
      const refusal = await restoreRefusal(user.id);
      return refusal === null ? null : failure(refusal, 422);
    }),
  },
);
