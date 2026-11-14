// app/models/license.rb, for what a seller does from the customers page (LicensesController#update): disable, enable, set,
// adjust and reset the uses. Creating a license (serial generation) and `rotate!` stay in Ruby.
import { Prisma, type License } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesNumericalityOf, validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export const MANAGE_SECURE_ID_SCOPE = "manage_license";
export const MAX_SELLER_SETTABLE_USES = 1_000_000;
const SEARCH_INDEX_DELAY_SECONDS = 2;

const paperTrail = hasPaperTrail<License>("License", { itemType: "License", only: ["disabled_at", "serial"] });

const validations: Callback<License>[] = [validatesNumericalityOf<License>(["uses"], { greater_than_or_equal_to: 0 }), validatesPresenceOf<License>(["serial"])];

export const Licenses = defineModel<License>({
  rubyClass: "License",
  prismaModel: "License",
  delegate: (tx) => tx.license as never,
  validations,
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
  afterCommit: [
    {
      // update_purchase_search_index: the fields the last save changed, enqueued for the purchase's index.
      name: "update_purchase_search_index",
      on: "update",
      async run(record) {
        const fields: string[] = [];
        if (record.savedChanges.serial) fields.push("license_serial");
        if (record.savedChanges.uses) fields.push("license_uses");
        const purchaseId = record.get("purchase_id");
        if (purchaseId == null || fields.length === 0) return;
        await performAsync("ElasticsearchIndexerWorker", ["update", { record_id: purchaseId, class_name: "Purchase", fields }], { delaySeconds: SEARCH_INDEX_DELAY_SECONDS });
      },
    },
  ],
});

export type LicenseRecord = ModelRecord<License>;

export async function findLicense(id: bigint | number): Promise<LicenseRecord | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "id")} = ${id} LIMIT 1`);
  return row ? Licenses.load(castRow<License>("License", row)) : null;
}

export const disabled = (license: LicenseRecord) => license.get("disabled_at") != null;

export async function disableBang(license: LicenseRecord, now: Date = new Date()): Promise<void> {
  license.set("disabled_at", now);
  await Licenses.saveBang(license);
}

export async function enableBang(license: LicenseRecord): Promise<void> {
  license.set("disabled_at", null);
  await Licenses.saveBang(license);
}

// `with_lock { update!(uses: value) }`: overwrites whatever a verify call incremented in the meantime.
export function setUsesBang(license: LicenseRecord, value: number): Promise<void> {
  return Licenses.withLock(license, async () => {
    await Licenses.updateBang(license, { uses: value });
  });
}

// Reads the count inside the lock so a concurrent verify is kept; the ceiling only applies while the count is inside the editable range.
export function adjustUsesBang(license: LicenseRecord, delta: number): Promise<void> {
  return Licenses.withLock(license, async () => {
    const current = license.get("uses") ?? 0;
    let target = current + delta;
    if (current <= MAX_SELLER_SETTABLE_USES) target = Math.min(Math.max(target, 0), MAX_SELLER_SETTABLE_USES);
    await Licenses.updateBang(license, { uses: Math.max(target, 0) });
  });
}

export const resetUsesBang = (license: LicenseRecord) => setUsesBang(license, 0);
