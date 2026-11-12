// Purchase#increment_affiliates_balance! / post_affiliate_credit! for a sale that credits a DirectAffiliate or a Collaborator (a
// direct affiliate beside a collaborator on one sale is handed back by the caller): the affiliate's BalanceTransaction (and the day's Balance), then the AffiliateCredit row that
// records it. The payout stays on Gumroad's account (`using_gumroad_merchant_account_for_affiliate_user?` is always true in Ruby), so
// no transfer and no registration mail follow.
// Golden: __fixtures__/purchase-affiliate-balance.golden.json (scripts/golden/purchase-affiliate-balance.rb), run by the real class.
//
// Every refusal comes before the first write. The caller reads the purchase's presentment up front for the same reason (see
// purchase-seller-balance.ts), because the affiliate is credited before the seller's share is booked.
import {
  Prisma,
  type Affiliate,
  type AffiliateCredit,
  type Balance,
  type MerchantAccount,
  type User,
} from "@prisma/client";

import { affiliateAmount } from "./balance-transaction-amounts.ts";
import {
  balanceTransactionBalance,
  BalanceTransactions,
  createBalanceTransactionBang,
  type BalanceTransactionRecord,
} from "./balance-transaction.ts";
import { type CheckoutEffects } from "./checkout-effects.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { belongsToRequired, setAssociation, type BelongsTo } from "./concerns/rails-validations.ts";
import { MerchantAccounts } from "./merchant-account.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord, Row } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { isFlagSet, NotPortedError, Users, type UserRecord } from "./user.ts";

export type AffiliateCreditRecord = ModelRecord<AffiliateCredit>;

export const AFFILIATE_CREDITS = "affiliate_credits";
const AFFILIATES = "affiliates";
const PRODUCT_AFFILIATES = "affiliates_links";
const DIRECT_AFFILIATE = "DirectAffiliate";
const COLLABORATOR = "Collaborator";
// has_flags 1 => :apply_to_all_products
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const BASIS_POINTS_PER_UNIT = 10_000.0;
const MAX_BASIS_POINTS = 100_00;
// Purchase::Searchable::AffiliateCreditCallbacks: ElasticsearchIndexerWorker.perform_in(2.seconds, ...)
const PURCHASE_INDEX_DELAY_SECONDS = 2;
const TRACKED_COLUMNS = ["id", "affiliate_user_id", "amount_cents", "fee_cents"] as const;

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#increment_affiliates_balance! with ${what}`, "app/models/purchase.rb:2010");

const belongsTo = (name: string, targetTable: string, targetModel: BelongsTo["targetModel"]): BelongsTo => ({
  name,
  foreignKey: `${name}_id`,
  targetTable,
  targetModel,
});
const AFFILIATE_USER: BelongsTo = { ...belongsTo("affiliate_user", "users", "User") };
const SELLER = belongsTo("seller", "users", "User");
const PURCHASE = belongsTo("purchase", "purchases", "Purchase");

export const AffiliateCredits = defineModel<AffiliateCredit>({
  rubyClass: "AffiliateCredit",
  prismaModel: "AffiliateCredit",
  delegate: (tx) => tx.affiliateCredit as never,
  validations: [
    belongsToRequired<AffiliateCredit>(AFFILIATE_USER),
    belongsToRequired<AffiliateCredit>(SELLER),
    belongsToRequired<AffiliateCredit>(PURCHASE),
    {
      name: "validates basis_points",
      run(credit) {
        const basisPoints = credit.get("basis_points");
        if (basisPoints == null) credit.errors.add("basis_points", "blank");
        else if (basisPoints < 0) credit.errors.add("basis_points", "greater_than_or_equal_to");
        else if (basisPoints > MAX_BASIS_POINTS) credit.errors.add("basis_points", "less_than_or_equal_to");
      },
    },
    {
      name: "affiliate_or_oauth_application_present",
      run(credit) {
        if (credit.get("affiliate_id") == null && credit.get("oauth_application_id") == null)
          credit.errors.add("base", "Either affiliate or oauth_application should be set on AffiliateCredit");
      },
    },
  ],
  afterCommit: [
    {
      // Purchase::Searchable::AffiliateCreditCallbacks#update_purchase_index
      name: "update_purchase_index",
      on: ["create", "update"],
      async run(credit) {
        const changed = Object.keys(credit.savedChanges).filter((name) =>
          (TRACKED_COLUMNS as readonly string[]).includes(name),
        );
        if (changed.length === 0) return;
        const fields = changed.map((name) => `affiliate_credit_${name}`);
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["update", { record_id: credit.get("purchase_id"), class_name: "Purchase", fields }] as never,
          { delaySeconds: PURCHASE_INDEX_DELAY_SECONDS },
        );
      },
    },
  ],
});

async function selectOne<T extends Row>(model: Prisma.ModelName, sql: Prisma.Sql): Promise<T | null> {
  const [row] = await selectRows(sql);
  return row ? castRow<T>(model, row) : null;
}

// `purchase.affiliate`: the Affiliate model reads an explicit column list
async function readAffiliate(id: bigint | number): Promise<Affiliate | null> {
  const columns = [
    "id",
    "seller_id",
    "affiliate_user_id",
    "affiliate_basis_points",
    "created_at",
    "updated_at",
    "deleted_at",
    "flags",
    "destination_url",
    "type",
  ].map((name) => column(AFFILIATES, name));
  return selectOne<Affiliate>(
    "Affiliate",
    Prisma.sql`SELECT ${Prisma.join(columns, ", ")} FROM ${table(AFFILIATES)} WHERE ${column(AFFILIATES, "id")} = ${id} LIMIT 1`,
  );
}

// DirectAffiliate#basis_points(product_id:) and Collaborator#basis_points(product_id:): the collaborator looks up the product's
// own rate whatever its apply_to_all_products flag says
async function basisPoints(affiliate: Affiliate, productId: bigint | number | null): Promise<number> {
  if (productId == null || (affiliate.type !== COLLABORATOR && (affiliate.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0))
    return affiliate.affiliate_basis_points!;
  const row = await selectOne<{ affiliate_basis_points: number | null }>(
    "ProductAffiliate",
    Prisma.sql`SELECT ${Prisma.raw("`affiliates_links`.*")} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${affiliate.id} AND ${column(PRODUCT_AFFILIATES, "link_id")} = ${productId} LIMIT 1`,
  );
  return row?.affiliate_basis_points ?? affiliate.affiliate_basis_points!;
}

const reader = (record: PurchaseRecord) => record.ivars.context as { seller: User; effects?: CheckoutEffects };

// determine_affiliate_fee_cents for a sale that does not also credit a direct affiliate
async function affiliateFeeCents(
  record: PurchaseRecord,
  affiliate: Affiliate,
  effects: Pick<CheckoutEffects, "featureActive">,
): Promise<number> {
  const fee = record.get("fee_cents");
  if (fee == null || fee === 0) return 0;
  // A collaborator always shares the fee: the seller-bears-the-fee flag and feature only apply to other affiliates
  if (
    affiliate.type !== COLLABORATOR &&
    (isFlagSet(Users.load(reader(record).seller), "bears_affiliate_fee") ||
      (await effects.featureActive("sellers_bear_affiliate_fees")))
  )
    return 0;
  return ((await basisPoints(affiliate, record.get("link_id"))) / BASIS_POINTS_PER_UNIT) * fee;
}

// `balance_transactions.where(user: affiliate_user).where.not(balance_id: nil).last&.balance`
async function appliedAffiliateBalance(
  record: PurchaseRecord,
  affiliateUserId: bigint | number,
): Promise<Balance | null> {
  const row = await selectOne<BalanceTransactionRecord["attributes"]>(
    "BalanceTransaction",
    Prisma.sql`SELECT ${Prisma.raw("`balance_transactions`.*")} FROM ${table("balance_transactions")} WHERE ${column("balance_transactions", "purchase_id")} = ${record.get("id")} AND ${column("balance_transactions", "user_id")} = ${affiliateUserId} AND ${Prisma.raw("`balance_transactions`.`balance_id` IS NOT NULL")} ORDER BY ${column("balance_transactions", "id")} DESC LIMIT 1`,
  );
  if (!row) return null;
  const balance = await balanceTransactionBalance(BalanceTransactions.load(row));
  return (balance?.attributes as Balance | undefined) ?? null;
}

// MerchantAccount.gumroad(charge_processor_id)
async function gumroadMerchantAccount(processor: string | null) {
  const row = await selectOne<MerchantAccount>(
    "MerchantAccount",
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IS NULL AND ${processor === null ? Prisma.raw("`merchant_accounts`.`charge_processor_id` IS NULL") : Prisma.sql`${column("merchant_accounts", "charge_processor_id")} = ${processor}`} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
  );
  return row ? MerchantAccounts.load(row) : null;
}

// increment_affiliates_balance! for a purchase with `affiliate_credit_cents > 0` (the caller has checked it and the purchase's
// merchant account). `chargedUsingGumroad` is `charged_using_gumroad_merchant_account?`, read by Ruby after the Gumroad account.
export async function incrementAffiliatesBalanceBang(
  record: PurchaseRecord,
  facts: {
    effects: Pick<CheckoutEffects, "featureActive">;
    chargedUsingGumroad: () => Promise<boolean>;
  },
  options: SaveOptions = {},
): Promise<void> {
  const creditCents = record.get("affiliate_credit_cents") ?? 0;
  const affiliateId = record.get("affiliate_id");
  const affiliate = affiliateId == null ? null : await readAffiliate(affiliateId);
  if (affiliate === null) throw notPorted("no affiliate");
  if (affiliate.type !== DIRECT_AFFILIATE && affiliate.type !== COLLABORATOR) throw notPorted(`a ${affiliate.type}`);
  if (affiliate.affiliate_basis_points == null || affiliate.affiliate_user_id == null)
    throw notPorted("an affiliate without a rate or a user");

  const feeCents = await affiliateFeeCents(record, affiliate, facts.effects);

  // return if affiliate_credit.present?
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`affiliate_credits`.*")} FROM ${table(AFFILIATE_CREDITS)} WHERE ${column(AFFILIATE_CREDITS, "purchase_id")} = ${record.get("id")} AND ${column(AFFILIATE_CREDITS, "is_direct_affiliate_credit")} = FALSE LIMIT 1`,
  );
  if (existing) return;

  const affiliateUser = await selectOne<User>(
    "User",
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${affiliate.affiliate_user_id} LIMIT 1`,
  );
  if (affiliateUser === null) throw notPorted("no affiliate user");

  let balance = await appliedAffiliateBalance(record, affiliateUser.id);
  if (balance === null) {
    const merchantAccount = await gumroadMerchantAccount(record.get("charge_processor_id"));
    if (merchantAccount === null) throw notPorted("no Gumroad merchant account");
    // update_user_balance_in_transaction_for_affiliate: only a charge on Gumroad's account is served
    if (!(await facts.chargedUsingGumroad())) throw notPorted("a seller's own Connect account");
    const amount = affiliateAmount(creditCents);
    const transaction = await createBalanceTransactionBang(
      {
        user: Users.load(affiliateUser) as UserRecord,
        merchantAccount,
        purchase: record as never,
        issuedAmount: amount,
        holdingAmount: amount,
      },
      options,
    );
    balance = (await balanceTransactionBalance(transaction))?.attributes as Balance;
  }

  // AffiliateCredit.create!: `basis_points || affiliate.basis_points(product_id: purchase.link_id)`
  const rate = await basisPoints(affiliate, record.get("link_id"));
  const credit = AffiliateCredits.build({
    is_direct_affiliate_credit: false,
    affiliate_id: affiliate.id,
    amount_cents: creditCents,
    fee_cents: BigInt(Math.ceil(feeCents)),
    basis_points: rate,
    seller_id: record.get("seller_id") as never,
    affiliate_credit_success_balance_id: balance.id,
    affiliate_user_id: affiliateUser.id as never,
    purchase_id: record.get("id") as never,
    link_id: record.get("link_id") as never,
  });
  const context = reader(record);
  setAssociation(credit, "seller", record.get("seller_id"), context.seller as never);
  setAssociation(credit, "affiliate_user", affiliateUser.id, affiliateUser as never);
  setAssociation(credit, "purchase", record.get("id"), record.attributes as never);
  await AffiliateCredits.saveBang(credit, options);
}
