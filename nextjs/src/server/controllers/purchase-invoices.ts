// Purchases::InvoicesController#confirm_email and the refusals of #create (app/controllers/purchases/invoices_controller.rb): the buyer
// retyping the purchase's email before the invoice form opens, and the two redirects #create answers before it does any work.
// #confirm and #new are Inertia pages (the former native, the latter in Rails).
//
// Handed to Rails whole once the guards pass: a #create that gets past them renders the PDF, uploads it to S3 and may refund VAT.
// So are the requests this port cannot read as Rails would: an email that is not text, a purchase with no email to compare, and an
// address that is a list (Rails raises on it).
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, RoutingError, type ActionResult, type Redirected } from "./application-controller.ts";
import { registerMutations, railsSegment, type MutationInput } from "./mutation.ts";
import { cgiEscape } from "./rails-query.ts";

const WARNING = "Please enter the purchase's email address to generate the invoice.";
const INCORRECT_EMAIL = "Incorrect email address. Please try again.";
const NOT_COMPLETED = "Your purchase has not been completed by PayPal yet. Please try again soon.";
const ADDRESS_REQUIRED = "Address information is required to generate an invoice.";
// params.permit(address_fields: [...]) in #invoice_params
const ADDRESS_KEYS = ["full_name", "street_address", "city", "state", "zip_code", "country_code"];

type PurchaseRow = { email: string | null; purchase_state: string | null };

// `set_purchase`: `Purchase.find_by_external_id(params[:purchase_id]) || e404`
async function setPurchase(input: MutationInput): Promise<PurchaseRow> {
  const id = decrypt(input.routeParams.purchase_id!);
  const [purchase] =
    id === null
      ? []
      : await selectRows<PurchaseRow>(
          Prisma.sql`SELECT ${column("purchases", "email")}, ${column("purchases", "purchase_state")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!purchase) throw new RoutingError("Not Found");
  return purchase;
}

const invoicePath = (input: MutationInput, action: "new" | "confirm", email?: string) =>
  `/purchases/${railsSegment(input.routeParams.purchase_id!)}/invoice/${action}${email === undefined ? "" : `?email=${cgiEscape(email)}`}`;

// `require_email_confirmation`: the email the buyer typed must be the purchase's, byte for byte.
function requireEmailConfirmation(input: MutationInput, purchase: PurchaseRow): Redirected | null {
  const submitted = input.params.email;
  if (submitted !== undefined && submitted !== null && typeof submitted !== "string")
    throw new HandBackToRails("an email that is not text");
  // `secure_compare(nil, ...)` raises, and an empty email is what a request without one compares equal to.
  if (isBlank(purchase.email)) throw new HandBackToRails("a purchase without an email");
  if (Buffer.from(purchase.email!).equals(Buffer.from(submitted ?? ""))) return null;
  const location = invoicePath(input, "confirm");
  return {
    status: 302,
    location,
    flash: isBlank(submitted) ? { warning: WARNING } : { alert: INCORRECT_EMAIL },
    // A halted before_action: the after_actions did not run.
    rescued: true,
  };
}

// `invoice_params[:email]`: a scalar the form sent, which after the confirmation is the purchase's own email.
const permittedEmail = (input: MutationInput): string | undefined => {
  const email = input.params.email;
  return typeof email === "string" ? email : undefined;
};

// `invoice_params["vat_id"].present?`: `permit` keeps a scalar and drops anything nested.
function vatIdPresent(input: MutationInput): boolean {
  const vatId = input.params.vat_id;
  if (typeof vatId === "string") return !isBlank(vatId);
  return typeof vatId === "number" || vatId === true;
}

// `invoice_params[:address_fields].blank?`: `permit` keeps the listed keys that hold a scalar (nil included).
function addressFieldsBlank(input: MutationInput): boolean {
  const fields = input.params.address_fields;
  if (Array.isArray(fields)) throw new HandBackToRails("an address given as a list, which Rails fails on");
  if (typeof fields !== "object" || fields === null) return true;
  // A hash keyed by numbers is a collection to `permit`.
  if (Object.keys(fields).some((key) => /^\d+$/u.test(key))) throw new HandBackToRails("an address keyed by numbers");
  const kept = ADDRESS_KEYS.filter((key) => {
    const value = (fields as Record<string, unknown>)[key];
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  });
  return kept.length === 0;
}

async function confirmEmail(input: MutationInput): Promise<ActionResult> {
  const purchase = await setPurchase(input);
  const refused = requireEmailConfirmation(input, purchase);
  if (refused) return refused;
  return { status: 303, location: invoicePath(input, "new", permittedEmail(input)) };
}

async function create(input: MutationInput): Promise<ActionResult> {
  const purchase = await setPurchase(input);
  const refused = requireEmailConfirmation(input, purchase);
  if (refused) return refused;

  // `set_chargeable` only reads, and has no refusal of its own.
  const back = (alert: string): Redirected => ({
    status: 302,
    location: invoicePath(input, "new", permittedEmail(input)),
    flash: { alert },
  });
  if (vatIdPresent(input) && purchase.purchase_state !== "successful") return back(NOT_COMPLETED);
  if (addressFieldsBlank(input)) return back(ADDRESS_REQUIRED);
  throw new HandBackToRails("generating the invoice renders a PDF, uploads it to S3 and may refund VAT");
}

registerMutations(
  { method: "POST", pattern: "/purchases/:purchase_id/invoice/confirm", run: confirmEmail },
  { method: "POST", pattern: "/purchases/:purchase_id/invoice", run: create },
);
