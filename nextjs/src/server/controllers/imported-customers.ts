// ImportedCustomersController#index, #destroy and #unsubscribe (app/controllers/imported_customers_controller.rb).
// `unsubscribe` toggles the customer and renders an ERB view in the application layout. A signed-in visitor goes to Rails whole,
// before the write: the layout then reads the visitor's analytics settings, which no recording pins.
import { Prisma, type ImportedCustomer } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { DEFAULT_FOOTER_CONTENT } from "../erb/home-layout.ts";
import { findImportedCustomerOf, importedCustomerJson, ImportedCustomers } from "../models/imported-customer.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { importedCustomerPolicy } from "../policies/imported-customer.ts";
import { loadSellerContext } from "../policies/seller-context.ts";

import {
  type ActionContext,
  type ActionResult,
  HandBackToRails,
  processAction,
  RoutingError,
} from "./application-controller.ts";
import { renderApplicationPage } from "./erb-pages.ts";
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

// app/views/imported_customers/unsubscribe.html.erb: the markup, and its `content_for :footer` block.
const UNSUBSCRIBE_VIEW = `<main class="grid divide-y divide-border bg-background border border-border rounded mx-auto my-4 h-min max-w-md w-[calc(100%-2rem)]">
  <header class="flex flex-col gap-4 p-4 text-center">
    <h2>You will no longer receive emails.</h2>
    <p>You can undo this action at any time by visiting this URL again.</p>
  </header>
</main>
`;
const UNSUBSCRIBE_FOOTER = `  ${DEFAULT_FOOTER_CONTENT}\n`;

async function unsubscribe(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const id = decrypt(input.routeParams.id!);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`imported_customers`.*")} FROM ${table("imported_customers")} WHERE ${column("imported_customers", "id")} = ${id} LIMIT 1`,
        );
  if (row === undefined) throw new RoutingError("Not Found");
  if (railsLoggedInUser(input.context) !== null)
    throw new HandBackToRails("a signed-in visitor of the unsubscribe page");
  // The page needs nothing from the customer, so it is built before the write: a view the port cannot render hands back untouched.
  const page = await renderApplicationPage(input.request, input, null, () => UNSUBSCRIBE_VIEW, {
    footer: UNSUBSCRIBE_FOOTER,
    // ApplicationController's own before_actions, in their declared order: the analytics tags come last.
    analyticsFirst: false,
  });
  // `deleted_at = deleted_at ? nil : Time.current; save!`
  const customer = ImportedCustomers.load(castRow<ImportedCustomer>("ImportedCustomer", row));
  customer.set("deleted_at", customer.get("deleted_at") === null ? new Date() : null);
  await ImportedCustomers.saveBang(customer);
  return page;
}

registerMutations(
  { method: "DELETE", pattern: "/imported_customers/:id", json: true, run: destroy },
  { method: "GET", pattern: "/imported_customers/unsubscribe/:id", skipForgeryProtection: true, run: unsubscribe },
);
