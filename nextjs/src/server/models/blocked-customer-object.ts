// Port of app/models/blocked_customer_object.rb: the email blocks the advanced settings page writes.
import { Prisma, type BlockedCustomerObject } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank, validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, findInBatches, selectRows, table } from "./sql.ts";
import { isValidEmailFormat } from "./user.ts";

export const BLOCKED_OBJECT_TYPES = { email: "email", charge_processor_fingerprint: "charge_processor_fingerprint" } as const;

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const TABLE = "blocked_customer_objects";
const paperTrail = hasPaperTrail<BlockedCustomerObject>("BlockedCustomerObject", { itemType: "BlockedCustomerObject" });

const isEmailType = (record: ModelRecord<BlockedCustomerObject>) => record.get("object_type") === BLOCKED_OBJECT_TYPES.email;

export const BlockedCustomerObjects = defineModel<BlockedCustomerObject>({
  rubyClass: "BlockedCustomerObject",
  prismaModel: "BlockedCustomerObject",
  delegate: (tx) => tx.blockedCustomerObject as never,
  validations: [
    belongsToRequired<BlockedCustomerObject>(SELLER),
    validatesPresenceOf<BlockedCustomerObject>(["object_type", "object_value"]),
    validatesPresenceOf<BlockedCustomerObject>(["buyer_email"], { if: (r) => r.get("object_type") === BLOCKED_OBJECT_TYPES.charge_processor_fingerprint }),
    validatesInclusionOf<BlockedCustomerObject>(["object_type"], { in: Object.values(BLOCKED_OBJECT_TYPES) }),
    {
      name: "validates :object_value, email_format (email type)",
      run(record) {
        if (isEmailType(record) && !isValidEmailFormat(record.get("object_value"))) record.errors.add("object_value", "invalid");
      },
    },
    {
      name: "validates :buyer_email, email_format, allow_blank",
      run(record) {
        const value = record.get("buyer_email");
        if (!isBlank(value) && !isValidEmailFormat(value)) record.errors.add("buyer_email", "invalid");
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});

const load = (row: unknown) => BlockedCustomerObjects.load(castRow<BlockedCustomerObject>("BlockedCustomerObject", row as never));
const activeEmails = (sellerId: unknown) =>
  Prisma.sql`${column(TABLE, "seller_id")} = ${sellerId} AND ${column(TABLE, "blocked_at")} IS NOT NULL AND ${column(TABLE, "object_type")} = ${BLOCKED_OBJECT_TYPES.email}`;

// `seller.blocked_customer_objects.active.email.pluck(:object_value)`
export async function activeBlockedEmails(sellerId: unknown): Promise<string[]> {
  const rows = await selectRows<{ object_value: string }>(Prisma.sql`SELECT ${column(TABLE, "object_value")} FROM ${table(TABLE)} WHERE ${activeEmails(sellerId)}`);
  return rows.map((row) => row.object_value);
}

// BlockedCustomerObject#unblock!
async function unblockBang(record: ModelRecord<BlockedCustomerObject>): Promise<void> {
  if (record.get("blocked_at") == null) return;
  await BlockedCustomerObjects.updateBang(record, { blocked_at: null });
}

// `seller.blocked_customer_objects.active.email.where(object_value: values).find_each(&:unblock!)`, or with no `values`
// `seller.blocked_customer_objects.active.find_each(&:unblock!)`.
export async function unblockActive(sellerId: unknown, options: { emailsOnly: boolean; values?: string[] }): Promise<void> {
  const values = options.values;
  if (values !== undefined && values.length === 0) return;
  const type = options.emailsOnly ? Prisma.sql` AND ${column(TABLE, "object_type")} = ${BLOCKED_OBJECT_TYPES.email}` : Prisma.empty;
  const names = values === undefined ? Prisma.empty : Prisma.sql` AND ${column(TABLE, "object_value")} IN (${Prisma.join(values)})`;
  const where = Prisma.sql`${column(TABLE, "seller_id")} = ${sellerId} AND ${column(TABLE, "blocked_at")} IS NOT NULL${type}${names}`;
  await findInBatches<Record<string, unknown>>(TABLE, where, 1000, async (rows) => {
    for (const row of rows) await unblockBang(load(row));
  });
}

// BlockedCustomerObject.block_email!
export async function blockEmailBang(email: string, sellerId: unknown): Promise<void> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`blocked_customer_objects`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "seller_id")} = ${sellerId} AND ${column(TABLE, "object_type")} = ${BLOCKED_OBJECT_TYPES.email} AND ${column(TABLE, "object_value")} = ${email} LIMIT 1`,
  );
  const record = row ? load(row) : BlockedCustomerObjects.build({ seller_id: sellerId as bigint, object_type: BLOCKED_OBJECT_TYPES.email, object_value: email });
  if (record.get("blocked_at") != null) return;
  record.set("blocked_at", new Date());
  await BlockedCustomerObjects.saveBang(record);
}
