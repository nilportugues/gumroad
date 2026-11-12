// The parts of app/models/merchant_account.rb (and User#stripe_account) the ported jobs read, and the
// save lifecycle the Stripe disconnect runs: validations, soft deletion and the recommendability
// refresh that `before_save` queues.
import { Prisma, type MerchantAccount } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { readBelongsTo } from "./concerns/belongs-to-record.ts";
import { deletable } from "./concerns/deletable.ts";
import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank, validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError, Users } from "./user.ts";

export const STRIPE_CHARGE_PROCESSOR_ID = "stripe";

export type MerchantAccountRow = {
  id: unknown;
  user_id: unknown;
  charge_processor_id: unknown;
  charge_processor_merchant_id: unknown;
  country: unknown;
  json_data: unknown;
};

// MerchantAccount#json_data.dig("meta", "stripe_connect"). JsonData's JSON coder reads a blank
// column as nil, which json_data turns into {}.
export function stripeConnectMeta(jsonData: unknown): unknown {
  const data: unknown =
    typeof jsonData === "string" ? (jsonData.trim() === "" ? null : JSON.parse(jsonData)) : jsonData;
  if (data == null) return undefined;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("json_data must be a hash");
  const meta = (data as Record<string, unknown>).meta;
  if (meta == null) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("json_data meta is not a Hash");
  return (meta as Record<string, unknown>).stripe_connect;
}

export const isStripeConnectAccount = (account: MerchantAccountRow) =>
  account.charge_processor_id === STRIPE_CHARGE_PROCESSOR_ID &&
  account.user_id != null &&
  stripeConnectMeta(account.json_data) === "true";

// MerchantAccount#is_a_gumroad_managed_stripe_account?
export const isGumroadManagedStripeAccount = (account: MerchantAccountRow) =>
  account.charge_processor_id === STRIPE_CHARGE_PROCESSOR_ID && stripeConnectMeta(account.json_data) !== "true";

// `user.merchant_accounts.alive.charge_processor_alive.stripe`
export function aliveStripeAccountsOf(userId: unknown): Promise<MerchantAccountRow[]> {
  return selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID}`,
  );
}

// User#stripe_account: the first non-Connect account of those, picked in Ruby.
export async function stripeAccountOf(userId: unknown): Promise<MerchantAccountRow | null> {
  return (await aliveStripeAccountsOf(userId)).find((account) => !isStripeConnectAccount(account)) ?? null;
}

export type MerchantAccountRecord = ModelRecord<MerchantAccount>;

const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";
const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const REFRESH_RECOMMENDABILITY_JOB = "RefreshMerchantAccountProductsRecommendationEligibilityJob";

// `json_data.dig("meta", "stripe_connect") == "true"` on the stored column. A value that is not a Hash counts as a
// connected payout account, the shape the recommendability backfill treats the same way.
function connectedByJsonData(jsonData: unknown): boolean {
  if (isBlank(jsonData)) return false;
  const data: unknown = typeof jsonData === "string" ? JSON.parse(jsonData) : jsonData;
  if (data == null) return false;
  if (typeof data !== "object" || Array.isArray(data)) return true;
  const meta = (data as Record<string, unknown>).meta;
  return meta != null && typeof meta === "object" && (meta as Record<string, unknown>).stripe_connect === "true";
}

// MerchantAccount#recommendation_payout_account_user_id_for
function recommendationPayoutAccountUserId(attributes: Record<string, unknown>): unknown {
  if (isBlank(attributes.user_id) || attributes.deleted_at != null) return null;
  if (attributes.charge_processor_alive_at == null || attributes.charge_processor_deleted_at != null) return null;
  const processor = attributes.charge_processor_id;
  const connected =
    processor === PAYPAL_CHARGE_PROCESSOR_ID ||
    (processor === STRIPE_CHARGE_PROCESSOR_ID && connectedByJsonData(attributes.json_data));
  return connected ? attributes.user_id : null;
}

// MerchantAccount#user_has_another_payout_method?
async function userHasAnotherPayoutMethod(userId: unknown, accountId: unknown): Promise<boolean> {
  const [user] = await selectRows<{ payment_address: string | null }>(
    Prisma.sql`SELECT ${column("users", "payment_address")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
  );
  if (!user) return false;
  if (!isBlank(user.payment_address)) return true;
  const banks = await selectRows(
    Prisma.sql`SELECT 1 AS present FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (banks.length > 0) return true;
  const others = await selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "id")} != ${accountId}`,
  );
  return others.some(
    (account) => account.charge_processor_id === PAYPAL_CHARGE_PROCESSOR_ID || isStripeConnectAccount(account),
  );
}

async function enqueueProductsRecommendabilityRefresh(userId: unknown, accountId: unknown): Promise<void> {
  try {
    if (await userHasAnotherPayoutMethod(userId, accountId)) return;
    await performAsync(REFRESH_RECOMMENDABILITY_JOB, [Number(userId)]);
  } catch (error) {
    notifyError(error, { merchant_account_id: accountId, user_id: userId });
  }
}

export const MerchantAccounts = defineModel<MerchantAccount>({
  rubyClass: "MerchantAccount",
  prismaModel: "MerchantAccount",
  delegate: (tx) => tx.merchantAccount as never,
  validations: [
    validatesPresenceOf<MerchantAccount>(["charge_processor_id"]),
    {
      // `presence: true, if: -> { user && charge_processor_alive? }`: the condition loads the user.
      name: "validates_presence_of charge_processor_merchant_id",
      async run(account, ctx) {
        const user = await loadBelongsTo(account, USER, ctx);
        if (
          user === null ||
          account.get("charge_processor_alive_at") == null ||
          account.get("charge_processor_deleted_at") != null
        )
          return;
        if (isBlank(account.get("charge_processor_merchant_id")))
          account.errors.add("charge_processor_merchant_id", "blank");
      },
    },
    validatesUniquenessOf<MerchantAccount>("merchant_accounts", ["charge_processor_merchant_id"], {
      case_sensitive: true,
      message: "This account is already connected with another Gumroad account",
      allow_blank: true,
      if: (account) => isGumroadManagedStripeAccount(account.attributes as unknown as MerchantAccountRow),
    }),
  ],
  beforeSave: [
    mergeJsonDataWithCurrentRow<MerchantAccount>("merchant_accounts"),
    {
      name: "schedule_products_recommendability_refresh",
      async run(account) {
        const current = { ...account.attributes } as Record<string, unknown>;
        const previous = { ...current };
        for (const [name, change] of Object.entries(account.changes())) previous[name] = change?.[0];
        const before = recommendationPayoutAccountUserId(previous);
        const after = recommendationPayoutAccountUserId(current);
        if (String(before) === String(after)) return;
        const affected = [...new Set([before, after].filter((id) => id != null).map(String))];
        await afterCommitEverywhere(async () => {
          for (const userId of affected) await enqueueProductsRecommendabilityRefresh(userId, account.get("id"));
        });
      },
    },
  ],
});

export const MerchantAccountDeletable = deletable(MerchantAccounts);

// MerchantAccount.find_by(charge_processor_merchant_id:)
export async function findMerchantAccountByProcessorMerchantId(id: string): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "charge_processor_merchant_id")} = ${id} LIMIT 1`,
  );
  return row ? MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row)) : null;
}

// MerchantAccount.gumroad(charge_processor_id): `where(user_id: nil, charge_processor_id:).first`
export async function gumroadMerchantAccountFor(processor: string): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${processor} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
  );
  return row ? MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row)) : null;
}

// `merchant_account.user`
export const merchantAccountUser = (account: MerchantAccountRecord) =>
  readBelongsTo(account, { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" }, Users);

export const HOLDER_OF_FUNDS = { GUMROAD: "gumroad", STRIPE: "stripe", CREATOR: "creator" } as const;

// MerchantAccount#is_a_stripe_connect_account?
export const isStripeConnectAccountRecord = (account: MerchantAccountRecord) =>
  account.get("charge_processor_id") === STRIPE_CHARGE_PROCESSOR_ID &&
  account.get("user_id") != null &&
  stripeConnectMeta(account.get("json_data")) === "true";

// MerchantAccount#holder_of_funds for a Stripe account (StripeChargeProcessor#holder_of_funds);
// the other processors' rules are not ported.
export async function holderOfFunds(account: MerchantAccountRecord): Promise<string> {
  if (account.get("charge_processor_id") !== STRIPE_CHARGE_PROCESSOR_ID)
    throw new NotPortedError(
      "MerchantAccount#holder_of_funds for a non-Stripe account",
      "app/models/merchant_account.rb:131",
    );
  if (isStripeConnectAccountRecord(account)) return HOLDER_OF_FUNDS.CREATOR;
  if (await merchantAccountUser(account)) return HOLDER_OF_FUNDS.STRIPE;
  return HOLDER_OF_FUNDS.GUMROAD;
}
