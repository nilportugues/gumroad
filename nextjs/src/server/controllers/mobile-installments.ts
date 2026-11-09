// Port of app/controllers/api/mobile/installments_controller.rb#show.
//
// Served here: the two 404s, for an installment that does not exist and for a request none of whose purchase_id, subscription_id,
// imported_customer_id or follower_id resolves. An installment with a context object goes to Rails whole, because
// Installment#installment_mobile_json_data creates url redirects and serializes product files, which are not ported.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails } from "./application-controller.ts";
import { fetchError, registerMobile, type MobileInput } from "./mobile-api.ts";

// fetch_context_object takes the first of these params that is `present?` (an `elsif` chain).
const CONTEXT_PARAMS = [
  ["purchase_id", "purchases"],
  ["subscription_id", "subscriptions"],
  ["imported_customer_id", "imported_customers"],
  ["follower_id", "followers"],
] as const;

async function exists(tableName: string, externalId: unknown): Promise<boolean> {
  const id = typeof externalId === "string" ? decrypt(externalId) : null;
  if (id === null) return false;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return rows.length > 0;
}

// Rails' `present?` on a param: a blank string, an empty array or hash and nil are absent.
function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

async function show(input: MobileInput) {
  if (!(await exists("installments", input.params.id))) return fetchError("Could not find installment");
  const context = CONTEXT_PARAMS.find(([name]) => present(input.params[name]));
  if (context !== undefined) {
    const value = input.params[context[0]];
    // find_by_external_id of a non-string (an array or a hash) is Ruby's to cast
    if (typeof value !== "string") throw new HandBackToRails(`a ${context[0]} that is not a string`);
    if (await exists(context[1], value)) throw new HandBackToRails("an installment with a context object");
  }
  return fetchError("Could not find related object to the installment.");
}

registerMobile({ method: "GET", pattern: "/mobile/installments/:id", scopes: null, run: show });
