// Purchase#increment_affiliates_balance! / post_affiliate_credit! for a sale that credits a DirectAffiliate, a Collaborator, or a
// Collaborator with a DirectAffiliate beside it (the direct affiliate is posted first and the collaborator's fee is taken from what
// its cut leaves): each affiliate's BalanceTransaction (and the day's Balance), then the AffiliateCredit row that records it. The payout stays on Gumroad's account (`using_gumroad_merchant_account_for_affiliate_user?` is always true in Ruby), so
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
import { setJsonDataForAttr } from "./concerns/json-data.ts";
import { associationCache, belongsToRequired, setAssociation, type BelongsTo } from "./concerns/rails-validations.ts";
import {
  attributesCommitted,
  transactionalAttributeChangeTracker,
} from "./concerns/transactional-attribute-change-tracker.ts";
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
const AFFILIATE_COLUMNS = [
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
] as const;
const TRACKED_COLUMNS = ["id", "affiliate_user_id", "amount_cents", "fee_cents"] as const;

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#increment_affiliates_balance! with ${what}`, "app/models/purchase.rb:2010");

const belongsTo = (name: string, targetTable: string, targetModel: BelongsTo["targetModel"]): BelongsTo => ({
  name,
  foreignKey: `${name}_id`,
  targetTable,
  targetModel,
});
export const AFFILIATE_USER: BelongsTo = { ...belongsTo("affiliate_user", "users", "User") };
const SELLER = belongsTo("seller", "users", "User");
const PURCHASE = belongsTo("purchase", "purchases", "Purchase");

const tracker = transactionalAttributeChangeTracker<AffiliateCredit>();

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
      async run(credit) {
        // `affiliate.present?`: a credit loaded from the database reads its affiliate, one built at checkout has it assigned
        const affiliateId = credit.get("affiliate_id");
        const cached = associationCache(credit).get("affiliate");
        if (affiliateId != null && !(cached && cached.foreignKey === affiliateId)) {
          const affiliate = await readAffiliate(affiliateId);
          setAssociation(credit, "affiliate", affiliateId, affiliate);
        }
        if (associationCache(credit).get("affiliate")?.row == null && credit.get("oauth_application_id") == null)
          credit.errors.add("base", "Either affiliate or oauth_application should be set on AffiliateCredit");
      },
    },
  ],
  afterSave: tracker.afterSave,
  beforeCommit: tracker.beforeCommit,
  afterCommit: [
    {
      // Purchase::Searchable::AffiliateCreditCallbacks#update_purchase_index
      name: "update_purchase_index",
      on: ["create", "update"],
      async run(credit) {
        const changed = attributesCommitted(credit).filter((name) =>
          (TRACKED_COLUMNS as readonly string[]).includes(name),
        );
        if (changed.length === 0) return;
        // A direct credit's document has no `id` field
        const fields = credit.get("is_direct_affiliate_credit")
          ? changed.filter((name) => name !== "id").map((name) => `direct_affiliate_credit_${name}`)
          : changed.map((name) => `affiliate_credit_${name}`);
        if (fields.length === 0) return;
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
export async function readAffiliate(id: bigint | number): Promise<Affiliate | null> {
  const columns = AFFILIATE_COLUMNS.map((name) => column(AFFILIATES, name));
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

// `DirectAffiliate.find_by(id: direct_affiliate_id)`
export async function readDirectAffiliate(id: bigint | number): Promise<Affiliate | null> {
  const columns = AFFILIATE_COLUMNS.map((name) => column(AFFILIATES, name));
  return selectOne<Affiliate>(
    "Affiliate",
    Prisma.sql`SELECT ${Prisma.join(columns, ", ")} FROM ${table(AFFILIATES)} WHERE ${column(AFFILIATES, "type")} = ${DIRECT_AFFILIATE} AND ${column(AFFILIATES, "id")} = ${id} LIMIT 1`,
  );
}

// The JsonData concern keeps the direct affiliate's accessors in the purchase's json_data
export function jsonDataOf(record: PurchaseRecord): Record<string, unknown> {
  const raw = record.get("json_data");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// `direct_affiliate_id.present?`
export function hasDirectAffiliateId(record: PurchaseRecord): boolean {
  const id = jsonDataOf(record).direct_affiliate_id;
  return id !== undefined && id !== null && id !== "";
}

// The purchase's `affiliate_credit` / `direct_affiliate_credit` (has_one, loaded once per instance)
async function creditRowExists(record: PurchaseRecord, direct: boolean): Promise<boolean> {
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`affiliate_credits`.*")} FROM ${table(AFFILIATE_CREDITS)} WHERE ${column(AFFILIATE_CREDITS, "purchase_id")} = ${record.get("id")} AND ${column(AFFILIATE_CREDITS, "is_direct_affiliate_credit")} = ${direct ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} LIMIT 1`,
  );
  return existing !== undefined;
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

type Facts = {
  effects: Pick<CheckoutEffects, "featureActive">;
  chargedUsingGumroad: () => Promise<boolean>;
};

type CreditPost = {
  affiliate: Affiliate;
  amountCents: number;
  feeCents: number;
  // The memoized basis points of a direct affiliate or a collaborator sharing a sale; null leaves the model to look the rate up.
  basisPoints: number | null;
  direct: boolean;
  // The plain path asks for an existing credit here; a sale with a direct affiliate asked while sizing the fee.
  checkExisting: boolean;
};

// post_affiliate_credit!: the affiliate's BalanceTransaction (and Balance), then the AffiliateCredit row
async function postAffiliateCredit(record: PurchaseRecord, facts: Facts, options: SaveOptions, post: CreditPost) {
  const { affiliate } = post;
  // return if (direct ? direct_affiliate_credit : affiliate_credit).present?
  if (post.checkExisting && (await creditRowExists(record, post.direct))) return;

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
    const amount = affiliateAmount(post.amountCents);
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
  const rate = post.basisPoints ?? (await basisPoints(affiliate, record.get("link_id")));
  const credit = AffiliateCredits.build({
    is_direct_affiliate_credit: post.direct,
    affiliate_id: affiliate.id,
    amount_cents: post.amountCents,
    fee_cents: BigInt(Math.ceil(post.feeCents)),
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
  setAssociation(credit, "affiliate", affiliate.id, affiliate as never);
  setAssociation(credit, "purchase", record.get("id"), record.attributes as never);
  await AffiliateCredits.saveBang(credit, options);
}

// `seller.bears_affiliate_fee? || Feature.active?(:sellers_bear_affiliate_fees)`, the first thing a direct affiliate's fee checks.
// When it holds, Ruby returns a fee of 0 and leaves `direct_affiliate_basis_points` unset, then hands `AffiliateCredit.create!` a
// blank rate. That sale is not recorded, so it is refused here, before the first write.
async function sellerBearsDirectAffiliateFee(record: PurchaseRecord, effects: Pick<CheckoutEffects, "featureActive">) {
  if (
    isFlagSet(Users.load(reader(record).seller), "bears_affiliate_fee") ||
    (await effects.featureActive("sellers_bear_affiliate_fees"))
  )
    throw notPorted("a direct affiliate beside a collaborator and a seller who bears the affiliate fee");
}

// A collaborator's sale that also credits a direct affiliate: the direct affiliate's credit first, then the collaborator's, whose fee
// is its cut of what is left of the fee after the direct affiliate's share. Both rates are memoized in the purchase's json_data
// (`direct_affiliate_basis_points`, `collaborator_basis_points`), which the seller's share save then writes.
async function incrementWithDirectAffiliate(
  record: PurchaseRecord,
  collaborator: Affiliate,
  direct: Affiliate,
  facts: Facts,
  options: SaveOptions,
): Promise<void> {
  const data = jsonDataOf(record);
  const directCents = Number(data.direct_affiliate_credit_cents ?? 0);
  const ownCents = (record.get("affiliate_credit_cents") ?? 0) - directCents;
  // Unrecorded: a sale where one credit is empty, and rates already memoized (a purchase credited before).
  if (directCents <= 0 || ownCents <= 0) throw notPorted("a direct affiliate beside a collaborator and an empty share");
  if ("direct_affiliate_basis_points" in data || "collaborator_basis_points" in data)
    throw notPorted("a direct affiliate beside a collaborator with its rates already stored");
  if (direct.affiliate_basis_points == null || direct.affiliate_user_id == null)
    throw notPorted("a direct affiliate without a rate or a user");
  const fee = record.get("fee_cents");
  if (fee == null || fee === 0) throw notPorted("a direct affiliate beside a collaborator and no fee");

  // post_affiliate_credit!(direct_affiliate, ..., determine_direct_affiliate_fee_cents, direct: true): the fee argument first,
  // its Flipper read, then `direct_affiliate_credit&.basis_points || direct_affiliate.basis_points(product_id:)`
  await sellerBearsDirectAffiliateFee(record, facts.effects);
  if (await creditRowExists(record, true)) throw notPorted("a direct affiliate credit already recorded");
  const directRate = await basisPoints(direct, record.get("link_id"));
  const directFee = (directRate / BASIS_POINTS_PER_UNIT) * fee;
  await postAffiliateCredit(record, facts, options, {
    affiliate: direct,
    amountCents: directCents,
    feeCents: directFee,
    basisPoints: directRate,
    direct: true,
    checkExisting: false,
  });

  // post_affiliate_credit!(affiliate, own_affiliate_credit_cents, determine_affiliate_fee_cents): `affiliate_cut`
  // (`affiliate_credit&.basis_points || affiliate.basis_points(product_id:)`) is read before the direct fee is worked out again
  if (await creditRowExists(record, false))
    throw notPorted("a collaborator credit already recorded beside a direct affiliate");
  const collaboratorRate = await basisPoints(collaborator, record.get("link_id"));
  await sellerBearsDirectAffiliateFee(record, facts.effects);
  await postAffiliateCredit(record, facts, options, {
    affiliate: collaborator,
    amountCents: ownCents,
    feeCents: (collaboratorRate / BASIS_POINTS_PER_UNIT) * (fee - directFee),
    basisPoints: collaboratorRate,
    direct: false,
    checkExisting: false,
  });

  setJsonDataForAttr(record, "direct_affiliate_basis_points", directRate);
  setJsonDataForAttr(record, "collaborator_basis_points", collaboratorRate);
}

// increment_affiliates_balance! for a purchase with `affiliate_credit_cents > 0` (the caller has checked it and the purchase's
// merchant account). `chargedUsingGumroad` is `charged_using_gumroad_merchant_account?`, read by Ruby after the Gumroad account.
export async function incrementAffiliatesBalanceBang(
  record: PurchaseRecord,
  facts: Facts,
  options: SaveOptions = {},
): Promise<void> {
  const creditCents = record.get("affiliate_credit_cents") ?? 0;
  const affiliateId = record.get("affiliate_id");
  const affiliate = affiliateId == null ? null : await readAffiliate(affiliateId);
  if (affiliate === null) throw notPorted("no affiliate");
  if (affiliate.type !== DIRECT_AFFILIATE && affiliate.type !== COLLABORATOR) throw notPorted(`a ${affiliate.type}`);
  if (affiliate.affiliate_basis_points == null || affiliate.affiliate_user_id == null)
    throw notPorted("an affiliate without a rate or a user");

  // credits_direct_affiliate?: direct_affiliate_id present, a collaborator, and the direct affiliate found
  if (hasDirectAffiliateId(record)) {
    if (affiliate.type !== COLLABORATOR) throw notPorted("a direct affiliate on a sale that is not a collaborator's");
    const direct = await readDirectAffiliate(jsonDataOf(record).direct_affiliate_id as number);
    if (direct === null) throw notPorted("a direct affiliate that no longer exists");
    await incrementWithDirectAffiliate(record, affiliate, direct, facts, options);
    return;
  }

  const feeCents = await affiliateFeeCents(record, affiliate, facts.effects);
  await postAffiliateCredit(record, facts, options, {
    affiliate,
    amountCents: creditCents,
    feeCents,
    basisPoints: null,
    direct: false,
    checkExisting: true,
  });
}
