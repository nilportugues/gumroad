// Api::V2::UpsellsController#index and #show (app/controllers/api/v2/upsells_controller.rb). Create, update and destroy run
// SaveUpsellService, whose validations and callbacks are not ported: they stay in Rails.
import { Prisma, type Upsell } from "@prisma/client";

import { IS_CONTENT_UPSELL, UPSELLS, upsellJson } from "../../models/upsell.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { errorWithObject, fromExternalId, PUBLIC_READ_SCOPES, registerApiV2, successWithObject } from "./base.ts";

// current_resource_owner.upsells.alive.not_is_content_upsell
const scope = (sellerId: bigint) => Prisma.sql`${column(UPSELLS, "seller_id")} = ${sellerId} AND ${column(UPSELLS, "deleted_at")} IS NULL AND (${column(UPSELLS, "flags")} & ${IS_CONTENT_UPSELL}) = 0`;

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/upsells",
    scopes: PUBLIC_READ_SCOPES,
    async run({ owner }) {
      const rows = await selectRows(Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${scope(owner.id)} ORDER BY ${column(UPSELLS, "id")}`);
      return successWithObject("upsells", await Promise.all(rows.map((row) => upsellJson(castRow<Upsell>("Upsell", row)))));
    },
  },
  {
    method: "GET",
    pattern: "/v2/upsells/:id",
    scopes: PUBLIC_READ_SCOPES,
    async run({ owner, routeParams }) {
      const id = fromExternalId(routeParams.id);
      const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${scope(owner.id)} AND ${column(UPSELLS, "id")} = ${id} LIMIT 1`);
      return row === undefined ? errorWithObject("upsell") : successWithObject("upsell", await upsellJson(castRow<Upsell>("Upsell", row)));
    },
  },
);
