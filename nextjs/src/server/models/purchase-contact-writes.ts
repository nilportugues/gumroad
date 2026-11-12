// `purchase.can_contact = ActiveModel::Type::Boolean.new.cast(params[:can_contact]); purchase.save!` (the customers page's "stop
// emailing this customer" toggle: PurchasesController#change_can_contact and Api::Mobile::SalesController#change_can_contact).
//
// `save!` validates and runs every Purchase callback, so Node writes only the purchase for which it can prove what Rails does:
// a successful, one-off purchase with no review, no gift, no preorder and no processor trace it cannot check, for a seller no
// newsletter cutover covers. Everything else goes to Rails before the write. For such a purchase the callbacks that fire are the
// ones `can_contact` reaches: PaperTrail, the Elasticsearch update (Purchase::ATTRIBUTE_TO_SEARCH_FIELDS) and the audience member
// refresh (Purchase::AudienceMember). The cutover fence and mirror (`fence_lifted_buyer_opt_out`, `mirror_buyer_opt_out`) do
// nothing for a seller outside it, and a save that changes nothing issues no UPDATE and enqueues nothing.
import { Prisma, type Purchase } from "@prisma/client";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { coveredByCutover } from "./follower.ts";
import { findById } from "./row-reads.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";

// ElasticsearchModelAsyncCallbacks: `perform_in(4.seconds, "update", ...)` with the fields `can_contact` maps to
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const CAN_CONTACT_SEARCH_FIELDS = ["can_contact"];
// ActiveModel::Type::Boolean::FALSE_VALUES
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);

const paperTrail = hasPaperTrail<Purchase>("Purchase", { itemType: "Purchase" });
// TransactionalAttributeChangeTracker: the attributes changed in the transaction, as `attributes_committed` after it
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const committedAttributes = (record: ModelRecord<Purchase>) => (record.ivars[COMMITTED] as string[] | undefined) ?? [];

export const ContactPurchases = defineModel<Purchase>({
  rubyClass: "Purchase",
  prismaModel: "Purchase",
  delegate: (tx) => tx.purchase as never,
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    {
      name: "TransactionalAttributeChangeTracker after_save",
      run(record) {
        record.ivars[COMMITTED] = null;
        const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
        for (const name of Object.keys(record.savedChanges)) changed.add(name);
      },
    },
  ],
  beforeCommit: [
    {
      name: "TransactionalAttributeChangeTracker before_commit",
      run(record) {
        const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
        if (changed === undefined) return;
        record.ivars[COMMITTED] = [...changed];
        changed.clear();
      },
    },
  ],
  // Declared in Ruby's order; the runtime runs them reversed.
  afterCommit: [
    {
      // Purchase::AudienceMember#schedule_audience_member_refresh_if_changed: `can_contact` is a watched attribute
      name: "schedule_audience_member_refresh_if_changed",
      on: "update",
      async run(record) {
        if (!committedAttributes(record).includes("can_contact")) return;
        await performAsync("RefreshAudienceMemberJob", [record.get("email"), record.get("seller_id")] as never);
      },
    },
    {
      name: "send_to_elasticsearch",
      on: "update",
      async run(record) {
        if (!committedAttributes(record).includes("can_contact")) return;
        await performAsync(
          "ElasticsearchIndexerWorker",
          [
            "update",
            { record_id: record.get("id"), class_name: "Purchase", fields: CAN_CONTACT_SEARCH_FIELDS },
          ] as never,
          { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS },
        );
      },
    },
  ],
});

// `ActiveModel::Type::Boolean#cast`. nil and "" cast to nil, which Rails stores as NULL; a list or hash is an unusual
// request, so those go to Rails.
export function castBoolean(value: unknown): boolean {
  if (value === null || value === undefined || value === "") throw new HandBackToRails("a blank can_contact");
  if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string")
    throw new HandBackToRails("a can_contact that is not a scalar");
  return !FALSE_VALUES.has(value);
}

type Reader = { id: bigint | number };

const exists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;

// The validations `save!` runs on an update of a successful purchase, and the callbacks that depend on what the purchase is.
// Each one that cannot be answered here hands the request back, so a purchase Rails would reject (a 422) is never written.
async function assertPlainSuccessfulPurchase(purchase: Purchase): Promise<void> {
  const refuse = (condition: boolean, what: string) => {
    if (condition) throw new HandBackToRails(what);
  };
  refuse(purchase.purchase_state !== "successful", "a purchase that is not successful");
  refuse(purchase.subscription_id !== null, "a purchase that belongs to a subscription");
  for (const flag of [
    "is_gift_sender_purchase",
    "is_gift_receiver_purchase",
    "is_preorder_authorization",
    "is_installment_payment",
  ] as const)
    refuse(PurchaseFlags.isSet(purchase.flags, flag), `a purchase with ${flag}`);
  // must_have_valid_email: `return if email && !email_changed?`
  refuse(purchase.email === null, "a purchase without an email");
  refuse(purchase.seller_id === null, "a purchase without a seller");
  refuse(
    purchase.price_cents === null || purchase.total_transaction_cents === null || purchase.fee_cents === null,
    "a purchase without its amounts",
  );
  // recommender_model_name's inclusion and custom_fee_per_thousand's range are validated when the key is set
  refuse(
    purchase.json_data !== null && /"(recommender_model_name|custom_fee_per_thousand)"/u.test(purchase.json_data),
    "a purchase with a recommender or a custom fee",
  );

  // seller_is_link_user, and the call presence validation
  const link = await findById<{ user_id: bigint | null; native_type: string | null }>("Link", purchase.link_id);
  refuse(link === null || link.user_id !== purchase.seller_id, "a purchase whose product is not the seller's");
  refuse(link!.native_type === "call", "a call purchase");
  refuse((await findById<Reader>("User", purchase.seller_id)) === null, "a purchase whose seller is gone");

  // financial_transaction_validation
  const merchantAccount = await findById<Reader>("MerchantAccount", purchase.merchant_account_id);
  const price = Number(purchase.price_cents ?? 0);
  if (price > 0) {
    refuse(
      isBlank(purchase.stripe_transaction_id) ||
        merchantAccount === null ||
        (isBlank(purchase.stripe_fingerprint) && purchase.paypal_order_id === null) ||
        isBlank(purchase.charge_processor_id),
      "a priced purchase whose processor trace is incomplete",
    );
  } else {
    refuse(
      !isBlank(purchase.stripe_transaction_id) ||
        !isBlank(purchase.stripe_fingerprint) ||
        purchase.charge_processor_id !== null ||
        merchantAccount !== null,
      "a free purchase with a processor trace",
    );
  }

  // Purchase::Reviews#update_product_review_stat reads the purchase's review
  refuse(
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${purchase.id} LIMIT 1`,
    ),
    "a purchase that has a review",
  );
}

export type CanContactChange = "changed" | "unchanged";

// `@purchase.can_contact = cast(value); @purchase.save!`
export async function changeCanContact(
  purchase: Purchase,
  value: unknown,
  options: { now?: () => Date } = {},
): Promise<CanContactChange> {
  const canContact = castBoolean(value);
  await assertPlainSuccessfulPurchase(purchase);
  if (purchase.can_contact === canContact) return "unchanged";

  // after_save :fence_lifted_buyer_opt_out / :mirror_buyer_opt_out
  if (purchase.seller_id !== null && (await coveredByCutover(Number(purchase.seller_id))))
    throw new HandBackToRails("a seller under a newsletter cutover");

  await ContactPurchases.updateBang(
    ContactPurchases.load(purchase),
    { can_contact: canContact },
    { validate: false, ...options },
  );
  return "changed";
}
