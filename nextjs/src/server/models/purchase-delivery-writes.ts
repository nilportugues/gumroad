// The writes UrlRedirectsController makes to a purchase: `update!(last_content_page_id:)` (save_last_content_page, a json_data
// attribute) and `purchase.purchaser = user; save!(validate: false)` (change_purchaser). Only the callbacks those columns reach
// are ported: PaperTrail, and the Elasticsearch update for `purchaser_id` (Purchase::ATTRIBUTE_TO_SEARCH_FIELDS). `json_data`
// is in no search map, and neither column is one the analytics cache or the inventory counters read.
import type { Purchase } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { setJsonDataForAttr } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";

// ElasticsearchModelAsyncCallbacks: `perform_in(4.seconds, "update", ...)`
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const committedAttributes = (record: ModelRecord<Purchase>) => (record.ivars[COMMITTED] as string[] | undefined) ?? [];

const paperTrail = hasPaperTrail<Purchase>("Purchase", { itemType: "Purchase" });

export const DeliveryPurchases = defineModel<Purchase>({
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
  afterCommit: [
    {
      name: "send_to_elasticsearch",
      on: "update",
      async run(record) {
        if (!committedAttributes(record).includes("purchaser_id")) return;
        await performAsync("ElasticsearchIndexerWorker", ["update", { record_id: record.get("id"), class_name: "Purchase", fields: ["purchaser_id"] }], { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS });
      },
    },
  ],
});

// `purchase.update!(last_content_page_id: page_id)`. Validations are not run: `update!` would raise (a 500) on a record that fails them.
export async function saveLastContentPageId(row: Purchase, pageId: string | null, options: { now?: () => Date } = {}): Promise<void> {
  const record = DeliveryPurchases.load(row);
  setJsonDataForAttr(record, "last_content_page_id", pageId);
  await DeliveryPurchases.saveBang(record, { validate: false, ...options });
}

// `purchase.purchaser = user; purchase.save!(validate: false)`
export async function changePurchaser(row: Purchase, purchaserId: bigint, options: { now?: () => Date } = {}): Promise<void> {
  await DeliveryPurchases.updateBang(DeliveryPurchases.load(row), { purchaser_id: purchaserId }, { validate: false, ...options });
}
