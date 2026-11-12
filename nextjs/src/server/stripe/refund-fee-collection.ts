// Port of StripeChargeProcessor.debit_stripe_account_for_refund_fee and the helpers behind it
// (app/business/payments/charging/implementations/stripe/stripe_charge_processor.rb): the collection of the processor fee a refund
// retains from a Gumroad-managed Stripe account, once the refund's transaction has committed.
//
// Nothing here knows the database or the HTTP client. `RefundStripe` is the Stripe leg (one call per Ruby class method, named as the
// golden names it) and `RefundFeeRefund` the refund row with the two writes the code makes (`with_lock`, `save!`), so the order of a
// pin, a call and a record is the order of the Ruby, which the golden pins. Golden: __fixtures__/refund-fee-retention.golden.json
// (scripts/golden/refund-fee-retention.rb), replayed in refund-fee-collection.test.ts.
//
// Not served yet: nothing registers this behind a route, because the transaction around it (the Refund insert, the balance
// transactions, the credit) is still Rails'. The `has_more` of a reversal list is refused (NotPortedError) rather than paged.
import { usdCentsToCurrency } from "../models/concerns/currency-helper.ts";
import { NotPortedError } from "../models/user.ts";
import { InvalidRequestError } from "./errors.ts";

export type StripeRequestOptions = { stripe_account?: string; idempotency_key?: string };
export type StripeRequest = {
  call: string;
  id?: string;
  secondId?: string;
  params?: Record<string, unknown>;
  options?: StripeRequestOptions;
};
export interface RefundStripe {
  call(request: StripeRequest): Promise<unknown>;
}

export type StripeList<T> = { data: T[]; has_more?: boolean };
export type StripeTransfer = { id: string; amount: number; amount_reversed: number; currency: string; reversals?: StripeList<StripeReversal> };
export type StripeReversal = {
  id: string;
  amount?: number;
  source_refund?: string | null;
  destination_payment_refund?: string | null;
  metadata?: Record<string, unknown> | null;
};

// StripeChargeProcessor::NoRefundFeeTransferError
export class NoRefundFeeTransferError extends Error {
  readonly rubyClass = "StripeChargeProcessor::NoRefundFeeTransferError";
}

// REFUND_FEE_REVERSAL_CAPACITY_ERROR, MAX_REFUND_FEE_REVERSAL_TRANSFERS
export const REFUND_FEE_REVERSAL_CAPACITY_ERROR = /remaining to reverse|already fully reversed/iu;
export const MAX_REFUND_FEE_REVERSAL_TRANSFERS = 3;
const NO_LONGER_SUPPORTED = /no longer supported/iu;
const TRANSFER_LIST_LIMIT = 100;
const FEE_RETENTION_TRANSFER_GROUP = "refund_fee_retention_";
// Stripe's "created before" cutoff for the transfers a refund fee may be taken from: recent sale transfers stay available for buyer refunds.
const RECENT_TRANSFER_DAYS = 120;
const SECONDS_PER_DAY = 86_400;
const USA = "US";

// The refund row: the JSON data the collection reads and writes, and the two writes.
export interface RefundFeeRefund {
  id: number;
  debitedStripeTransfer: string | null;
  feeRetentionSourceTransfer: string | null;
  feeRetentionCollectedCents: number | null;
  feeRetentionWrittenOffAt: string | null;
  // refund.with_lock { ... }: takes the row lock and reloads the fields above before running `fn`.
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  // refund.save!
  save(): Promise<void>;
}

export type RefundFeeCredit = {
  amountCents: number;
  merchantAccount: { chargeProcessorMerchantId: string | null; holderOfFunds: "stripe" | "gumroad" | string; country: string; currency: string };
  refund: RefundFeeRefund | null;
  // user.payments.completed.where(stripe_connect_account_id: ...).order(:created_at).pluck(:stripe_internal_transfer_id)
  internalTransferIds(): Promise<(string | null)[]>;
};

export type CollectionDeps = {
  stripe: RefundStripe;
  // `now` for the 120-day cutoff, in seconds
  nowSeconds: () => number;
  // STRIPE_PLATFORM_ACCOUNT_ID
  platformAccountId: string | null;
  // The rate is read where `usd_cents_to_currency` reads it; a test pins it.
  usdCentsToCurrency?: (currency: string, cents: number) => Promise<number>;
};

const blank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const present = (value: unknown): boolean => !blank(value);

class Collector {
  constructor(
    private readonly deps: CollectionDeps,
    private readonly credit: RefundFeeCredit,
    private readonly refund: RefundFeeRefund,
  ) {}

  private get stripeAccountId() {
    return this.credit.merchantAccount.chargeProcessorMerchantId!;
  }

  private call(request: StripeRequest) {
    return this.deps.stripe.call(request);
  }

  private convert(currency: string, cents: number) {
    return (this.deps.usdCentsToCurrency ?? usdCentsToCurrency)(currency, cents);
  }

  private get transferGroup() {
    return `${FEE_RETENTION_TRANSFER_GROUP}${this.refund.id}`;
  }

  // debit_stripe_account_for_refund_fee(credit:, collect: true)
  async debit(collect: boolean): Promise<number | null | undefined> {
    const { credit, refund } = this;
    if (credit.amountCents === 0) return undefined;
    if (blank(credit.merchantAccount.chargeProcessorMerchantId)) return undefined;
    if (credit.merchantAccount.holderOfFunds !== "stripe") return undefined;
    if (present(refund.feeRetentionWrittenOffAt)) return undefined;
    if (present(refund.debitedStripeTransfer)) return this.recordedRefundFeeCollection();
    if (!collect) return this.adoptExistingRefundFeeCollection();
    // US Gumroad-managed accounts cannot reverse payout transfers; collect with the grouped account debit.
    if (credit.merchantAccount.country === USA) return this.debitRefundFeeFromAccount();

    const usdAmountCents = Math.abs(credit.amountCents);
    // Each candidate transfer is compared, and reversed, in its own currency.
    const amountToReverseFor = (transfer: StripeTransfer) => this.convert(transfer.currency, usdAmountCents);
    const reversible = async (transfer: StripeTransfer) => transfer.amount - transfer.amount_reversed > (await amountToReverseFor(transfer));

    const alreadyPinnedId = refund.feeRetentionSourceTransfer;
    let observedPin = alreadyPinnedId;
    let transferReversal: StripeReversal | null | undefined = null;
    let transfer: StripeTransfer | null = null;
    if (present(alreadyPinnedId)) {
      // Fail closed on a retrieve error: a lost successful reversal must be looked up on this pin.
      transfer = (await this.call({ call: "Transfer.retrieve", id: alreadyPinnedId! })) as StripeTransfer;
      transferReversal = await this.existingRefundFeeReversal(transfer.id, refund.id);
      if (!transferReversal && !(transfer.amount - transfer.amount_reversed > (await amountToReverseFor(transfer)))) {
        const groupedDebit = await this.existingRefundFeeGroupedDebit();
        if (groupedDebit) return this.adoptRefundFeeGroupedDebit(groupedDebit);
        transfer = null;
      }
    }
    let lookupError: unknown = null;
    if (!transfer) ({ transfer, lookupError } = await this.findRefundFeeTransfer(reversible));
    if (!transfer) {
      const collected = await this.adoptExistingRefundFeeCollection();
      if (collected) return collected;
      if (lookupError) throw lookupError;
      // A pin can belong to an in-flight collection. Leave it for reconciliation.
      if (present(alreadyPinnedId)) return undefined;
      throw new NoRefundFeeTransferError("No reversible transfer for refund fee retention");
    }

    let refusedReversals = 0;
    for (;;) {
      try {
        const early = await refund.withLock(async (): Promise<{ done: true; value: number | null | undefined } | null> => {
          if (present(refund.feeRetentionWrittenOffAt)) return { done: true, value: undefined };
          if (present(refund.debitedStripeTransfer)) return { done: true, value: await this.recordedRefundFeeCollection() };
          const currentPin = refund.feeRetentionSourceTransfer;
          if (present(currentPin) && currentPin !== observedPin) return { done: true, value: undefined };
          if (currentPin !== transfer!.id) {
            refund.feeRetentionSourceTransfer = transfer!.id;
            await refund.save();
          }
          return null;
        });
        if (early) return early.value;
        transferReversal ??= (await this.call({
          call: "Transfer.create_reversal",
          id: transfer!.id,
          params: { amount: await amountToReverseFor(transfer!), metadata: { refund_id: String(refund.id) } },
          options: { idempotency_key: `refund_fee_retention_reversal_${refund.id}_${transfer!.id}` },
        })) as StripeReversal;
        break;
      } catch (error) {
        if (!(error instanceof InvalidRequestError)) throw error;
        const message = error.message;
        if (NO_LONGER_SUPPORTED.test(message)) return this.debitRefundFeeFromAccount();
        if (!REFUND_FEE_REVERSAL_CAPACITY_ERROR.test(message)) throw error;

        refusedReversals += 1;
        if (refusedReversals >= MAX_REFUND_FEE_REVERSAL_TRANSFERS) throw error;
        // The pin only moves once Stripe shows no reversal of this refund on it; a failed lookup raises.
        observedPin = transfer!.id;
        transferReversal = await this.existingRefundFeeReversal(transfer!.id, refund.id);
        if (transferReversal) break;
        // A refused transfer stays out: its refreshed remaining capacity no longer fits the fee.
        ({ transfer } = await this.findRefundFeeTransfer(reversible));
        if (!transfer) throw error;
      }
    }
    refund.debitedStripeTransfer = transferReversal!.id;
    await refund.save();
    return this.recordReversalCollectedCents(transferReversal!);
  }

  // find_refund_fee_transfer: the internal payout transfers first, then Stripe's list of older sale transfers.
  private async findRefundFeeTransfer(reversible: (transfer: StripeTransfer) => Promise<boolean>) {
    let lookupError: unknown = null;
    let transfer: StripeTransfer | null = null;
    for (const transferId of await this.credit.internalTransferIds()) {
      if (blank(transferId)) continue;
      let candidate: StripeTransfer;
      try {
        candidate = (await this.call({ call: "Transfer.retrieve", id: transferId! })) as StripeTransfer;
      } catch (error) {
        lookupError = error;
        continue;
      }
      if (await reversible(candidate)) {
        transfer = candidate;
        break;
      }
    }
    if (!transfer) {
      const params: Record<string, unknown> = {
        destination: this.stripeAccountId,
        created: { lt: this.deps.nowSeconds() - RECENT_TRANSFER_DAYS * SECONDS_PER_DAY },
        limit: TRANSFER_LIST_LIMIT,
      };
      for (;;) {
        const page = (await this.call({ call: "Transfer.list", params: { ...params } })) as StripeList<StripeTransfer>;
        for (const candidate of page.data) {
          if (await reversible(candidate)) {
            transfer = candidate;
            break;
          }
        }
        if (transfer || page.data.length < TRANSFER_LIST_LIMIT) break;
        params.starting_after = page.data[page.data.length - 1]!.id;
      }
    }
    return { transfer, lookupError };
  }

  private async debitRefundFeeFromAccount(): Promise<number> {
    const { refund, credit } = this;
    if (present(refund.debitedStripeTransfer)) return (await this.recordedRefundFeeCollection())!;

    const { currency } = credit.merchantAccount;
    const transferGroup = this.transferGroup;
    // The lookup survives Stripe's idempotency-key expiry if the debit was never recorded locally.
    let transfer = await this.existingRefundFeeGroupedDebit();
    transfer ??= (await this.call({
      call: "Transfer.create",
      params: {
        amount: await this.convert(currency, Math.abs(credit.amountCents)),
        currency,
        destination: this.deps.platformAccountId,
        transfer_group: transferGroup,
        metadata: { refund_id: refund.id },
      },
      options: { stripe_account: this.stripeAccountId, idempotency_key: transferGroup },
    })) as StripeTransfer;
    refund.debitedStripeTransfer = transfer.id;
    refund.feeRetentionCollectedCents = transfer.amount;
    await refund.save();
    return transfer.amount;
  }

  private async adoptExistingRefundFeeCollection(): Promise<number | null | undefined> {
    const { refund } = this;
    if (present(refund.debitedStripeTransfer)) return this.recordedRefundFeeCollection();

    const groupedDebit = await this.existingRefundFeeGroupedDebit();
    if (groupedDebit) return this.adoptRefundFeeGroupedDebit(groupedDebit);

    const pin = refund.feeRetentionSourceTransfer;
    if (blank(pin)) return undefined;

    // Fail closed on a retrieve error: a lost successful reversal on this pin must be looked up, not treated as "no collection".
    const transfer = (await this.call({ call: "Transfer.retrieve", id: pin! })) as StripeTransfer;
    const transferReversal = await this.existingRefundFeeReversal(transfer.id, refund.id);
    if (!transferReversal) return undefined;

    refund.debitedStripeTransfer = transferReversal.id;
    await refund.save();
    return this.recordReversalCollectedCents(transferReversal);
  }

  private async existingRefundFeeGroupedDebit(): Promise<StripeTransfer | undefined> {
    const page = (await this.call({
      call: "Transfer.list",
      params: { transfer_group: this.transferGroup, limit: 1 },
      options: { stripe_account: this.stripeAccountId },
    })) as StripeList<StripeTransfer>;
    return page.data[0];
  }

  private async adoptRefundFeeGroupedDebit(transfer: StripeTransfer): Promise<number> {
    this.refund.debitedStripeTransfer = transfer.id;
    this.refund.feeRetentionCollectedCents = transfer.amount;
    await this.refund.save();
    return transfer.amount;
  }

  private async existingRefundFeeReversal(transferId: string, refundId: number): Promise<StripeReversal | null> {
    if (blank(transferId) || blank(refundId)) return null;
    const reversals = (await this.call({ call: "Transfer.list_reversals", id: transferId, params: { limit: 100 } })) as StripeList<StripeReversal>;
    if (reversals.has_more) throw new NotPortedError("Transfer.list_reversals past the first page", "stripe_charge_processor.rb: each_refund_fee_reversal");
    const expected = String(refundId);
    for (const reversal of reversals.data) {
      const metadata = reversal.metadata;
      if (blank(metadata) || Object.keys(metadata!).length === 0) continue;
      if (String(metadata!.refund_id ?? "") !== expected) continue;
      return reversal;
    }
    return null;
  }

  private async recordedRefundFeeCollection(): Promise<number | undefined> {
    const { refund } = this;
    if (refund.feeRetentionCollectedCents !== null) return refund.feeRetentionCollectedCents;

    if (present(refund.feeRetentionSourceTransfer)) {
      const reversal = (await this.call({
        call: "Transfer.retrieve_reversal",
        id: refund.feeRetentionSourceTransfer!,
        secondId: refund.debitedStripeTransfer!,
      })) as StripeReversal;
      return this.recordReversalCollectedCents(reversal);
    }
    const transfer = (await this.call({
      call: "Transfer.retrieve",
      id: refund.debitedStripeTransfer!,
      options: { stripe_account: this.stripeAccountId },
    })) as StripeTransfer;
    refund.feeRetentionCollectedCents = transfer.amount;
    await refund.save();
    return transfer.amount;
  }

  // record_reversal_collected_cents!: what Stripe took from the seller's account, read from the refund of the destination payment.
  private async recordReversalCollectedCents(reversal: StripeReversal): Promise<number> {
    const options = { stripe_account: this.stripeAccountId };
    const destinationRefund = (await this.call({ call: "Refund.retrieve", id: reversal.destination_payment_refund!, options })) as { balance_transaction: string };
    const balanceTransaction = (await this.call({ call: "BalanceTransaction.retrieve", id: destinationRefund.balance_transaction, options })) as { net: number };
    this.refund.feeRetentionCollectedCents = Math.abs(balanceTransaction.net);
    await this.refund.save();
    return this.refund.feeRetentionCollectedCents;
  }
}

// StripeChargeProcessor.debit_stripe_account_for_refund_fee(credit:, collect:)
export async function debitStripeAccountForRefundFee(
  deps: CollectionDeps,
  credit: RefundFeeCredit,
  collect = true,
): Promise<number | null | undefined> {
  if (credit.refund === null) return undefined;
  return new Collector(deps, credit, credit.refund).debit(collect);
}
