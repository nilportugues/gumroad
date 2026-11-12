// Port of app/models/credit.rb: the record, its validations and its after_create comment. The
// create_for_* class methods that call BalanceTransaction live in credit-creation.ts, which
// imports this file (BalanceTransaction reads credits, so the two cannot import each other).
// Golden: worker/jobs/__fixtures__/money-jobs.golden.json.
import type { Credit, Comment } from "@prisma/client";

import { formattedDollarAmount } from "./concerns/currency-helper.ts";
import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { rubyJsonParse } from "./concerns/serialized-columns.ts";
import { Comments } from "./comment.ts";
import { Payments, type PaymentRecord } from "./payment.ts";
import { MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { NotPortedError, Users, type UserRecord } from "./user.ts";

export type CreditRecord = ModelRecord<Credit>;

const assoc = (name: string, targetTable: string, targetModel: BelongsTo["targetModel"], foreignKey = `${name}_id`): BelongsTo => ({ name, foreignKey, targetTable, targetModel });
export const CREDIT_USER = assoc("user", "users", "User");
export const CREDIT_MERCHANT_ACCOUNT = assoc("merchant_account", "merchant_accounts", "MerchantAccount");
export const CREDIT_CREDITING_USER = assoc("crediting_user", "users", "User");
export const CREDIT_RETURNED_PAYMENT = assoc("returned_payment", "payments", "Payment");

// The belongs_to associations validate_associated_entity and add_comment look at, in the order
// they are read. Only crediting_user is ported; the others' models are not.
const UNPORTED_ENTITIES = [
  ["chargebacked_purchase_id", "chargebacked_purchase"],
  ["refund_id", "refund"],
  ["financing_paydown_purchase_id", "financing_paydown_purchase"],
  ["fee_retention_refund_id", "fee_retention_refund"],
  ["backtax_agreement_id", "backtax_agreement"],
] as const satisfies readonly (readonly [keyof Credit, string])[];

const refuseUnportedEntity = (credit: CreditRecord, upTo: string) => {
  for (const [column, name] of UNPORTED_ENTITIES) {
    if (credit.get(column) != null) throw new NotPortedError(`Credit#${name}`, "app/models/credit.rb:573 validate_associated_entity");
    if (name === upTo) return;
  }
};

export const creditUser = (credit: CreditRecord) => readBelongsTo(credit, CREDIT_USER, Users);
export const creditMerchantAccount = (credit: CreditRecord) => readBelongsTo(credit, CREDIT_MERCHANT_ACCOUNT, MerchantAccounts);
export const creditCreditingUser = (credit: CreditRecord) => readBelongsTo(credit, CREDIT_CREDITING_USER, Users);
export const assignCreditUser = (credit: CreditRecord, user: UserRecord | null) => assignBelongsTo(credit, CREDIT_USER, user);
export const assignCreditMerchantAccount = (credit: CreditRecord, account: MerchantAccountRecord | null) => assignBelongsTo(credit, CREDIT_MERCHANT_ACCOUNT, account);
export const creditReturnedPayment = (credit: CreditRecord) => readBelongsTo(credit, CREDIT_RETURNED_PAYMENT, Payments);
export const assignCreditReturnedPayment = (credit: CreditRecord, payment: PaymentRecord | null) => assignBelongsTo(credit, CREDIT_RETURNED_PAYMENT, payment);
export const assignCreditCreditingUser = (credit: CreditRecord, user: UserRecord | null) => assignBelongsTo(credit, CREDIT_CREDITING_USER, user);

// json_data["stripe_loan_paydown_id"] / ["stripe_loan_paydown_reason"] (attr_json_data_accessor)
function jsonDataValue(credit: CreditRecord, key: string): unknown {
  const raw = credit.get("json_data");
  if (isBlank(raw)) return undefined;
  const data = rubyJsonParse(raw!) as Record<string, unknown> | null;
  return data?.[key];
}

const AUTOMATIC_CAPITAL_WITHHOLDING = "automatic_withholding";

// Credit#automatic_capital_deduction?
function isAutomaticCapitalDeduction(credit: CreditRecord): boolean {
  const paydownId = jsonDataValue(credit, "stripe_loan_paydown_id");
  return !isBlank(paydownId as string | null) && (credit.get("financing_paydown_purchase_id") != null || jsonDataValue(credit, "stripe_loan_paydown_reason") === AUTOMATIC_CAPITAL_WITHHOLDING);
}

// Credit#capital_deduction_date; a Capital deduction is read from json_data, not ported.
export function capitalDeductionDate(credit: CreditRecord): null {
  if (!isBlank(jsonDataValue(credit, "stripe_loan_paydown_deducted_at") as string | null)) throw new NotPortedError("Credit#capital_deduction_date", "app/models/credit.rb:268");
  return null;
}

async function addComment(credit: CreditRecord, ctx: { now?: () => Date }): Promise<void> {
  // fee_retention_refund.present?
  if (credit.get("fee_retention_refund_id") != null) throw new NotPortedError("Credit#fee_retention_refund", "app/models/credit.rb:523 add_comment");
  const reason = credit.get("reason");
  const attrs: Partial<Comment> = {
    content: `issued ${formattedDollarAmount(credit.get("amount_cents") as number)} credit${isBlank(reason) ? "" : ` — ${reason}`}.`,
    comment_type: "credit",
  };
  if (await creditCreditingUser(credit)) {
    attrs.author_id = BigInt(credit.get("crediting_user_id") as number);
  } else {
    refuseUnportedEntity(credit, "chargebacked_purchase");
    const returnedPayment = await creditReturnedPayment(credit);
    if (returnedPayment) {
      attrs.author_name = `AutoCredit Returned Payment (${String(returnedPayment.get("id"))})`;
      attrs.content = `issued adjustment due to currency conversion differences when payment ${String(returnedPayment.get("id"))} returned.`;
    } else {
      refuseUnportedEntity(credit, "refund");
    }
  }
  const user = await creditUser(credit);
  if (user === null) throw new TypeError("undefined method 'comments' for nil");
  // user.comments.create(...): a failed validation is not raised.
  await Comments.create({ ...attrs, commentable_id: user.get("id") as never, commentable_type: "User" }, { now: ctx.now });
}

export const Credits = defineModel<Credit>({
  rubyClass: "Credit",
  prismaModel: "Credit",
  delegate: (tx) => tx.credit as never,
  validations: [
    validatesAssociationPresence<Credit>(CREDIT_USER),
    validatesAssociationPresence<Credit>(CREDIT_MERCHANT_ACCOUNT),
    {
      name: "validate_associated_entity",
      async run(credit) {
        if (await creditCreditingUser(credit)) return;
        refuseUnportedEntity(credit, "chargebacked_purchase");
        if (await creditReturnedPayment(credit)) return;
        refuseUnportedEntity(credit, "backtax_agreement");
        if (isAutomaticCapitalDeduction(credit)) return;
        credit.errors.add(
          "base",
          "A crediting user, chargebacked purchase, returned payment, refund, financing_paydown_purchase, fee_retention_refund or backtax_agreement must be provided.",
        );
      },
    },
  ],
  beforeSave: [
    {
      // JsonData: a stored credit's json_data is merged with the row's; nothing here writes it.
      name: "merge_json_data_with_current_row",
      if: (credit) => credit.persisted && credit.attributeChanged("json_data"),
      run() {
        throw new NotPortedError("Writing json_data on a stored credit (JsonData#merge_json_data_with_current_row)", "app/models/concerns/json_data.rb");
      },
    },
  ],
  afterCreate: [{ name: "add_comment", run: (credit, ctx) => addComment(credit, ctx) }],
});
