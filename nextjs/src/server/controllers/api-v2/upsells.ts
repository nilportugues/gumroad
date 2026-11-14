// Api::V2::UpsellsController (app/controllers/api/v2/upsells_controller.rb). Node answers #index, #show, the 404 of #update and #destroy,
// and #destroy of an upsell without a discount code. Create and update run SaveUpsellService, and deleting a code runs OfferCode callbacks;
// neither is ported, so Rails takes them whole.
import { Prisma, type Upsell } from "@prisma/client";

import { IS_CONTENT_UPSELL, UPSELLS, upsellJson } from "../../models/upsell.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails } from "../application-controller.ts";
import { softDeleteUpsell } from "../checkout-upsells.ts";
import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, errorWithObject, fromExternalId, PUBLIC_READ_SCOPES, registerApiV2, successWithObject } from "./base.ts";

// current_resource_owner.upsells.alive.not_is_content_upsell
const scope = (sellerId: bigint) => Prisma.sql`${column(UPSELLS, "seller_id")} = ${sellerId} AND ${column(UPSELLS, "deleted_at")} IS NULL AND (${column(UPSELLS, "flags")} & ${IS_CONTENT_UPSELL}) = 0`;

async function findUpsell(sellerId: bigint, externalId: unknown) {
  const id = fromExternalId(externalId);
  const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${scope(sellerId)} AND ${column(UPSELLS, "id")} = ${id} LIMIT 1`);
  return row === undefined ? undefined : castRow<Upsell>("Upsell", row);
}

// before_action :fetch_upsell
async function loadUpsell({ owner, routeParams }: ApiV2Input) {
  return (await findUpsell(owner.id, routeParams.id)) === undefined ? errorWithObject("upsell") : undefined;
}

const writeToRails = (): never => {
  throw new HandBackToRails("an upsell write");
};

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
      const upsell = await findUpsell(owner.id, routeParams.id);
      return upsell === undefined ? errorWithObject("upsell") : successWithObject("upsell", await upsellJson(upsell));
    },
  },
  { method: "POST", pattern: "/v2/upsells", scopes: EDIT_PRODUCTS_SCOPES, run: writeToRails },
  { method: "PATCH", pattern: "/v2/upsells/:id", scopes: EDIT_PRODUCTS_SCOPES, before: loadUpsell, run: writeToRails },
  { method: "PUT", pattern: "/v2/upsells/:id", scopes: EDIT_PRODUCTS_SCOPES, before: loadUpsell, run: writeToRails },
  {
    method: "DELETE",
    pattern: "/v2/upsells/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadUpsell,
    async run({ owner, routeParams }) {
      await softDeleteUpsell((await findUpsell(owner.id, routeParams.id))!);
      return successWithObject("upsell", null);
    },
  },
);
