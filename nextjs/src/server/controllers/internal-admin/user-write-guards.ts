// Api::Internal::Admin::UsersController: the writes that send mail, move a user through the risk state machine, queue a refund job or
// create a credit. Each answers its parameter and lookup refusals and the branches that change nothing (an account already in the
// state asked for, a refund whose expected figures are off), then hands the write back to Rails whole before the first change.
import { db } from "../../../lib/db.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank, jsonRendered, paramToS, recordAdminWrite, type AdminRequest } from "./base.ts";
import { emailFormatValid } from "./email-format.ts";
import { handBack } from "./hand-back.ts";
import { idFromExternalId, textParam } from "./products.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite, USER_ID_REQUIRED_MESSAGE } from "./user-writes.ts";
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
      return forUser("users.two_factor_authentication", "a two-factor change")(admin);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/mark_compliant",
    run: forUser("users.mark_compliant", "a compliance change", async (user, admin) => {
      const state = await riskState(user);
      if (state === "compliant")
        return jsonRendered(ok(user, { status: "already_compliant", message: "User is already compliant" }));
      if (state !== null && SUSPENDED_STATES.includes(state) && !truthy(admin.params.clear_suspension))
        return failure(`User is ${state}; pass clear_suspension=true to lift the suspension as well`, 422);
      return null;
    }),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/suspend_for_fraud",
    run: forUser(
      "users.suspend_for_fraud",
      "a fraud suspension",
      alreadySuspended("suspended_for_fraud", "User is already suspended for fraud"),
    ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/users/suspend_for_tos_violation",
    run: forUser(
      "users.suspend_for_tos_violation",
      "a policy suspension",
      alreadySuspended("suspended_for_tos_violation", "User is already suspended for a policy violation"),
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
    run: forUser("users.restore_bank_payout_rail", "a bank payout restore"),
  },
);
