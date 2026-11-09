// Port of app/models/billing_detail.rb: the invoice details a seller saves on the billing settings page.
import { Prisma, type BillingDetail } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesLengthOf, validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const PURCHASER: BelongsTo = { name: "purchaser", foreignKey: "purchaser_id", targetTable: "users", targetModel: "User" };
const TABLE = "billing_details";
const COUNTRY_CODE_LENGTH = 2;

export const BillingDetails = defineModel<BillingDetail>({
  rubyClass: "BillingDetail",
  prismaModel: "BillingDetail",
  delegate: (tx) => tx.billingDetail as never,
  validations: [
    belongsToRequired<BillingDetail>(PURCHASER),
    validatesPresenceOf<BillingDetail>(["full_name", "street_address", "city", "zip_code", "country_code"]),
    // `us_address?`: state is required for US addresses only.
    validatesPresenceOf<BillingDetail>(["state"], { if: (record: ModelRecord<BillingDetail>) => record.get("country_code") === "US" }),
    validatesLengthOf<BillingDetail>(["country_code"], { is: COUNTRY_CODE_LENGTH }),
    validatesUniquenessOf<BillingDetail>(TABLE, ["purchaser_id"], {}),
  ],
});

// `BillingDetail.find_or_initialize_by(purchaser_id:)`: the row, or null when the seller has none yet.
export async function billingDetailOfPurchaser(purchaserId: bigint): Promise<ModelRecord<BillingDetail> | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`\`${TABLE}\`.*`)} FROM ${table(TABLE)} WHERE ${column(TABLE, "purchaser_id")} = ${purchaserId} LIMIT 1`);
  return row ? BillingDetails.load(castRow<BillingDetail>("BillingDetail", row)) : null;
}
