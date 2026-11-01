// The one write the library makes to a purchase: `update!(is_archived:)` and `update!(is_deleted_by_buyer:)`
// (LibraryController#archive, #unarchive, #delete). Both change only `flags`, so the callbacks that fire are the
// ones `flags` reaches: PaperTrail, the Elasticsearch update (Purchase::ATTRIBUTE_TO_SEARCH_FIELDS) and
// Purchase::CreatorAnalyticsCallbacks. The others (inventory counters, workflows, fees) key off purchase_state,
// stripe_refunded and chargeback_date, which this write never changes. Validations are not run: `update!` would
// raise on a record that fails them (500); Node saves it.
import type { Purchase } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";
import { instantInTimeZoneIso8601 } from "./concerns/rails-time-zone.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";

// ElasticsearchModelAsyncCallbacks: `perform_in(4.seconds, "update", ...)`; CreatorAnalyticsCallbacks: `perform_in(2.seconds, ...)`
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const CREATOR_ANALYTICS_DELAY_SECONDS = 2;
// Purchase::ATTRIBUTE_TO_SEARCH_FIELDS["flags"]
const FLAGS_SEARCH_FIELDS = ["selected_flags", "not_chargedback_or_chargedback_reversed", "not_subscription_or_original_subscription_purchase", "referrer_domain"];
// Purchase::CreatorAnalyticsCallbacks: the attributes whose change regenerates the day's cache
const ANALYTICS_ATTRIBUTES = ["chargeback_date", "flags", "purchase_state", "stripe_refunded"];

const paperTrail = hasPaperTrail<Purchase>("Purchase", { itemType: "Purchase" });
const SELLER_TIMEZONE = "sellerTimezone";
// TransactionalAttributeChangeTracker: the attributes changed in the transaction, as `attributes_committed` after it
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";
const committedAttributes = (record: ModelRecord<Purchase>) => (record.ivars[COMMITTED] as string[] | undefined) ?? [];

const localDate = (timezone: string, instant: Date) => instantInTimeZoneIso8601(timezone, instant).slice(0, 10);

export const LibraryPurchases = defineModel<Purchase>({
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
        if (!committedAttributes(record).includes("flags")) return;
        await performAsync("ElasticsearchIndexerWorker", ["update", { record_id: record.get("id"), class_name: "Purchase", fields: FLAGS_SEARCH_FIELDS }], { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS });
      },
    },
    {
      name: "update_creator_analytics_cache",
      on: "update",
      async run(record, { now }) {
        if (!ANALYTICS_ATTRIBUTES.some((name) => committedAttributes(record).includes(name))) return;
        const timezone = record.ivars[SELLER_TIMEZONE] as string;
        const purchaseDate = localDate(timezone, record.get("created_at") as Date);
        // The cache does not cover the seller's today.
        if (purchaseDate === localDate(timezone, (now ?? (() => new Date()))())) return;
        await performAsync("RegenerateCreatorAnalyticsCacheWorker", [Number(record.get("seller_id")), purchaseDate], { delaySeconds: CREATOR_ANALYTICS_DELAY_SECONDS });
      },
    },
  ],
});

export type LibraryPurchase = ModelRecord<Purchase>;

export function loadLibraryPurchase(row: Purchase, sellerTimezone: string): LibraryPurchase {
  const record = LibraryPurchases.load(row);
  record.ivars[SELLER_TIMEZONE] = sellerTimezone;
  return record;
}

export type LibraryFlag = "is_archived" | "is_deleted_by_buyer";

// `purchase.update!(flag => value)`
export async function setLibraryFlag(record: LibraryPurchase, flag: LibraryFlag, value: boolean, options: { now?: () => Date } = {}): Promise<void> {
  await LibraryPurchases.updateBang(record, { flags: PurchaseFlags.set(record.get("flags"), flag, value) as never }, { validate: false, ...options });
}
