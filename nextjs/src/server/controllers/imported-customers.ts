// ImportedCustomersController#index, #destroy and the 404 of #unsubscribe (app/controllers/imported_customers_controller.rb).
// `unsubscribe` toggles the customer and renders an ERB view, so a customer that exists goes to Rails whole, before the write.
import { Prisma, type ImportedCustomer } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { findImportedCustomerOf, importedCustomerJson, ImportedCustomers } from "../models/imported-customer.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { importedCustomerPolicy } from "../policies/imported-customer.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { type ActionContext, type ActionResult, HandBackToRails, processAction, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { assertFlatQuery, requestFormat } from "./rails-params.ts";
import { queryParam } from "./rails-request.ts";
import { authorizeJson, json } from "./seller-json.ts";
import { requireHtml } from "./users-controller.ts";

// CustomersController::CUSTOMERS_PER_PAGE
const CUSTOMERS_PER_PAGE = 20;
const MAX_PAGE_DIGITS = 9;

// String#to_i
function rubyToI(value: string): number {
  const match = /^\s*([+-]?\d[\d_]*)/u.exec(value);
  if (match === null) return 0;
  const digits = match[1]!.replaceAll("_", "");
  if (digits.replace(/^[+-]/u, "").length > MAX_PAGE_DIGITS) throw new HandBackToRails("a page number beyond what the port reads");
  return Number(digits);
}

async function list(action: ActionContext): Promise<ActionResult> {
  const { request, context } = action;
  const seller = context.currentSeller;
  if (railsLoggedInUser(context) === null || seller === null) throw new HandBackToRails("a signed-out request");
  if (requestFormat(request) !== "json") throw new HandBackToRails("a request whose format is not JSON");
  assertFlatQuery(request.queryString);

  const denied = await authorizeJson(action, (sellerContext) => authorize(importedCustomerPolicy.index, sellerContext));
  if (denied) return denied;

  const permalink = queryParam(request, "link_id");
  const page = rubyToI(queryParam(request, "page") ?? "");
  if (page < 0) throw new HandBackToRails("a negative page");
  const filter =
    permalink != null && permalink.trim() !== ""
      ? Prisma.sql` AND ${column("imported_customers", "link_id")} IN (SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} IN (${permalink}))`
      : Prisma.empty;
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`imported_customers`.*")} FROM ${table("imported_customers")} WHERE ${column("imported_customers", "importing_user_id")} = ${seller.id} AND ${column("imported_customers", "deleted_at")} IS NULL${filter} ORDER BY imported_customers.purchase_date DESC LIMIT ${CUSTOMERS_PER_PAGE} OFFSET ${page * CUSTOMERS_PER_PAGE}`,
  );
  const canUpdate = importedCustomerPolicy.update(await loadSellerContext(context));
  const customers = [];
  for (const row of rows) customers.push(await importedCustomerJson(castRow<ImportedCustomer>("ImportedCustomer", row), canUpdate));
  return json({ customers, begin_loading_imported_customers: true });
}

export const importedCustomersResponse = (incoming: Request): Promise<Response> => processAction(incoming, {}, list);

async function destroy(input: MutationInput): Promise<ActionResult> {
  const seller = input.context.currentSeller;
  if (railsLoggedInUser(input.context) === null || seller === null) throw new HandBackToRails("a signed-out request");
  const id = decrypt(input.routeParams.id!);
  const customer = id === null ? null : await findImportedCustomerOf(seller.id, id);
  // `authorize nil` raises Pundit::NotDefinedError in Rails, which answers 500.
  if (customer === null) throw new NotPortedError("ImportedCustomersController#destroy", "a customer that does not exist");
  const denied = await authorizeJson(input, (sellerContext) => authorize(importedCustomerPolicy.destroy, sellerContext));
  if (denied) return denied;

  // `deleted_at = Time.current; save!`
  customer.set("deleted_at", new Date());
  await ImportedCustomers.saveBang(customer);
  return json({ success: true, message: "Deleted!", imported_customer: await importedCustomerJson(customer.attributes, null) });
}

async function unsubscribe(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const id = decrypt(input.routeParams.id!);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("imported_customers", "id")} FROM ${table("imported_customers")} WHERE ${column("imported_customers", "id")} = ${id} LIMIT 1`,
        );
  if (row === undefined) throw new RoutingError("Not Found");
  throw new HandBackToRails("an imported customer to unsubscribe, which renders an ERB view");
}

registerMutations(
  { method: "DELETE", pattern: "/imported_customers/:id", json: true, run: destroy },
  { method: "GET", pattern: "/imported_customers/unsubscribe/:id", skipForgeryProtection: true, run: unsubscribe },
);
