// Api::V2::SalesController#resend_receipt (app/controllers/api/v2/sales_controller.rb). The other sales actions render
// Purchase#as_json(version: 2), which is not ported; #refund moves money and belongs to phase 2.
import { Prisma } from "@prisma/client";

import { performAsync } from "../../models/concerns/job-runtime.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { HandBackToRails } from "../application-controller.ts";
import { errorWithObject, fromExternalId, registerApiV2, renderResponse } from "./base.ts";

registerApiV2({
  method: "POST",
  pattern: "/v2/sales/:id/resend_receipt",
  scopes: ["edit_sales"],
  async run({ owner, routeParams }) {
    // current_resource_owner.sales.find_by_external_id
    const id = fromExternalId(routeParams.id);
    const [sale] =
      id === null
        ? []
        : await selectRows<{ id: bigint; sender: bigint | number; authorization: bigint | number }>(
            Prisma.sql`SELECT ${column("purchases", "id")}, (CASE WHEN ${PurchaseFlags.condition("is_gift_sender_purchase", true)} THEN 1 ELSE 0 END) AS sender, (CASE WHEN ${PurchaseFlags.condition("is_preorder_authorization", true)} THEN 1 ELSE 0 END) AS authorization FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${owner.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
          );
    if (sale === undefined) return errorWithObject("sale");
    // A preorder authorization sends a CustomerMailer.preorder_receipt and a gift sender also the giftee's receipt.
    if (Number(sale.authorization) === 1 || Number(sale.sender) === 1) throw new HandBackToRails("a preorder authorization or gift sender receipt");

    await performAsync("SendPurchaseReceiptJob", [Number(sale.id), true]);
    return renderResponse(true);
  },
});
