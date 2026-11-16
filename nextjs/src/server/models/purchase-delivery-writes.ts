// The writes UrlRedirectsController makes to a purchase: `update!(last_content_page_id:)` (save_last_content_page, a json_data
// attribute) and `purchase.purchaser = user; save!(validate: false)` (change_purchaser). Only the callbacks those columns reach
// are ported: PaperTrail, and the Elasticsearch update for `purchaser_id` (Purchase::ATTRIBUTE_TO_SEARCH_FIELDS). `json_data`
// is in no search map, and neither column is one the analytics cache or the inventory counters read.
import { Prisma, type Purchase } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { setJsonDataForAttr } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

// ElasticsearchModelAsyncCallbacks: `perform_in(4.seconds, "update", ...)`
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const committedAttributes = (record: ModelRecord<Purchase>) => (record.ivars[COMMITTED] as string[] | undefined) ?? [];

const paperTrail = hasPaperTrail<Purchase>("Purchase", { itemType: "Purchase" });

// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];

// Purchase#attach_unclaimed_bundle_product_purchases (after_save, when the purchaser changed): only this bundle's unclaimed members whose
// email still matches. Each is locked and reloaded first, since a claim that lands after the select must not be overwritten; one that fails
// is reported and the rest go on.
async function attachUnclaimedBundleProductPurchases(record: ModelRecord<Purchase>, now: () => Date): Promise<void> {
  if (!PurchaseFlags.isSet(record.get("flags"), "is_bundle_purchase")) return;
  const purchaserId = record.get("purchaser_id");
  if (purchaserId === null || purchaserId === undefined) return;
  const email = record.get("email");
  const members = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} INNER JOIN ${table("bundle_product_purchases")} ON ${column("purchases", "id")} = ${column("bundle_product_purchases", "product_purchase_id")} WHERE ${column("bundle_product_purchases", "bundle_purchase_id")} = ${record.get("id")} AND ${column("purchases", "purchase_state")} IN (${Prisma.join(ALL_SUCCESS_STATES)}) AND ${column("purchases", "purchaser_id")} IS NULL ORDER BY ${column("purchases", "id")} ASC`,
  );
  for (const { id } of members) {
    try {
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1 FOR UPDATE`,
      );
      if (row === undefined) continue;
      const member = DeliveryPurchases.load(castRow<Purchase>("Purchase", row));
      if (member.get("purchaser_id") !== null) continue;
      if (isBlankEmail(email) || member.get("email")?.toLowerCase() !== email?.toLowerCase()) continue;
      if (PurchaseFlags.isSet(member.get("flags"), "is_reassignment_locked")) continue;
      await DeliveryPurchases.updateBang(member, { purchaser_id: purchaserId }, { validate: false, now });
    } catch (error) {
      notifyError(error, { purchase_id: id, bundle_purchase_id: record.get("id"), user_id: purchaserId });
    }
  }
}

const isBlankEmail = (email: string | null | undefined) => email === null || email === undefined || email.trim() === "";

export const DeliveryPurchases = defineModel<Purchase>({
  rubyClass: "Purchase",
  prismaModel: "Purchase",
  delegate: (tx) => tx.purchase as never,
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    {
      name: "attach_unclaimed_bundle_product_purchases",
      if: (record) => record.savedChangeTo("purchaser_id"),
      run: (record, { now }) => attachUnclaimedBundleProductPurchases(record, now ?? (() => new Date())),
    },
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
  afterCommit: [
    {
      name: "send_to_elasticsearch",
      on: "update",
      async run(record) {
        if (!committedAttributes(record).includes("purchaser_id")) return;
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["update", { record_id: record.get("id"), class_name: "Purchase", fields: ["purchaser_id"] }],
          { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS },
        );
      },
    },
  ],
});

// `purchase.update!(last_content_page_id: page_id)`. Validations are not run: `update!` would raise (a 500) on a record that fails them.
export async function saveLastContentPageId(
  row: Purchase,
  pageId: string | null,
  options: { now?: () => Date } = {},
): Promise<void> {
  const record = DeliveryPurchases.load(row);
  setJsonDataForAttr(record, "last_content_page_id", pageId);
  await DeliveryPurchases.saveBang(record, { validate: false, ...options });
}

// `purchase.purchaser = user; purchase.save!(validate: false)`
export async function changePurchaser(
  row: Purchase,
  purchaserId: bigint,
  options: { now?: () => Date } = {},
): Promise<void> {
  await DeliveryPurchases.updateBang(
    DeliveryPurchases.load(row),
    { purchaser_id: purchaserId },
    { validate: false, ...options },
  );
}
