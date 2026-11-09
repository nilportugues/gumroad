// Port of app/controllers/api/mobile/preorders_controller.rb#preorder_attributes.
//
// Served here: the 404 for an id that is not an `authorization_successful` or `charge_successful` preorder. A preorder that is found
// goes to Rails whole, because Preorder#mobile_json_data serializes the product updates of its purchase (UrlRedirect#product_json_data or
// Purchase#update_json_data_for_mobile), which are not ported.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails } from "./application-controller.ts";
import { fetchError, registerMobile, type MobileInput } from "./mobile-api.ts";

const PREORDER_STATES = ["authorization_successful", "charge_successful"];

// Preorder.authorization_successful_or_charge_successful.find_by_external_id
async function preorderAttributes(input: MobileInput) {
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const rows =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 FROM ${table("preorders")} WHERE ${column("preorders", "id")} = ${id} AND ${column("preorders", "state")} IN (${Prisma.join(PREORDER_STATES)}) LIMIT 1`,
        );
  if (rows.length === 0) return fetchError("Could not find preorder");
  throw new HandBackToRails("a preorder that exists");
}

registerMobile({
  method: "GET",
  pattern: "/mobile/preorders/preorder_attributes/:id",
  scopes: null,
  run: preorderAttributes,
});
