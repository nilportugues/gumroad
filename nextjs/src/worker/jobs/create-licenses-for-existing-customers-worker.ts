// Port of app/sidekiq/create_licenses_for_existing_customers_worker.rb: every successful, non-gift-sender, non-recurring sale of the
// product gets a License unless it has one already or its variant's own content leaves the license-key block out
// (Purchase#variant_content_permits_license_key?). The reads run in Rails' order and through the query cache, which a write clears.
// Sales are read 1000 at a time, each next batch after the writes of the one before. An id Rails casts (a Float, a word) hands back before any statement.
// Golden: __fixtures__/create-licenses-for-existing-customers-worker.golden.json (scripts/golden/create-licenses-for-existing-customers-worker.rb).
import { Prisma, type Link, type License } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { Licenses } from "../../server/models/license.ts";
import { variantContentPermitsLicenseKey } from "../../server/models/purchase-license-key.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SALES_BATCH_SIZE = 1000;
const SERIAL_GROUP_LENGTH = 8;

type Row = Record<string, unknown>;

// Purchase.successful_gift_or_nongift.not_is_gift_sender_purchase.not_recurring_charge, scoped to the product.
const salesOf = (productId: bigint) =>
  Prisma.sql`${column("purchases", "link_id")} = ${productId} AND ${column("purchases", "purchase_state")} IN ('successful', 'gift_receiver_purchase_successful') AND ((${column("purchases", "flags")} & 64 = 0)) AND (purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32')`;

// License#generate_serial: the uuid's 32 hex digits in groups of eight.
export function licenseSerial(uuid: string): string {
  const digits = uuid.toUpperCase().replaceAll("-", "");
  const groups: string[] = [];
  for (let i = 0; i + SERIAL_GROUP_LENGTH <= digits.length; i += SERIAL_GROUP_LENGTH)
    groups.push(digits.slice(i, i + SERIAL_GROUP_LENGTH));
  return groups.join("-");
}

export const createLicensesForExistingCustomersWorkerWith = modelJob({ min: 1 }, async ([productId], deps) => {
  if (productId === null) throw new RecordNotFound("Couldn't find Link without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findOneBy<Link>("Link", "id", id);
  if (product === null) throw new RecordNotFound(`Couldn't find Link with 'id'=${String(id)}`);

  await findInBatches<Row>("purchases", salesOf(id), SALES_BATCH_SIZE, async (purchases) => {
    for (const purchase of purchases) {
      if (!(await variantContentPermitsLicenseKey(purchase, product as unknown as Row))) continue;

      // License.where(link:, purchase:).first_or_create!
      const [existing] = await selectRows<Row>(
        Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "link_id")} = ${id} AND ${column("licenses", "purchase_id")} = ${purchase.id} ORDER BY ${column("licenses", "id")} ASC LIMIT 1`,
      );
      if (existing !== undefined) continue;
      await transaction(() =>
        Licenses.createBang(
          {
            link_id: id,
            purchase_id: purchase.id as bigint,
            serial: licenseSerial(deps.uuid()),
          } as unknown as Partial<License>,
          { now: deps.now },
        ),
      );
    }
  });
});

export const createLicensesForExistingCustomersWorker = createLicensesForExistingCustomersWorkerWith();
