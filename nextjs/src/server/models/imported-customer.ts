// app/models/imported_customer.rb: the listing JSON (`as_json`) and the soft delete (Deletable). Creating a customer, and the
// license a licensed product creates for it (`create_or_get_license`), stay in Ruby.
import { Prisma, type ImportedCustomer, type License } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { bit } from "../presenters/product-reads.ts";
import { timeAgoInWords } from "./concerns/time-ago-in-words.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const IS_LICENSED_FLAG = 7;

export const ImportedCustomers = defineModel<ImportedCustomer>({
  rubyClass: "ImportedCustomer",
  prismaModel: "ImportedCustomer",
  delegate: (tx) => tx.importedCustomer as never,
  validations: [validatesPresenceOf<ImportedCustomer>(["email"])],
});

// `current_seller.imported_customers.find_by_external_id(id)`
export async function findImportedCustomerOf(sellerId: bigint | number, id: number): Promise<ReturnType<typeof ImportedCustomers.load> | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`imported_customers`.*")} FROM ${table("imported_customers")} WHERE ${column("imported_customers", "importing_user_id")} = ${sellerId} AND ${column("imported_customers", "id")} = ${id} LIMIT 1`,
  );
  return row ? ImportedCustomers.load(castRow<ImportedCustomer>("ImportedCustomer", row)) : null;
}

// `link.name` and `link.is_licensed?` for the customer's product, which may be gone.
async function productOf(linkId: number | null): Promise<{ name: string | null; licensed: boolean } | null> {
  if (linkId === null) return null;
  const [link] = await selectRows<{ name: string | null; flags: bigint | number | null }>(Prisma.sql`SELECT ${column("links", "name")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${linkId} LIMIT 1`);
  return link ? { name: link.name, licensed: bit(link.flags, IS_LICENSED_FLAG) } : null;
}

// ImportedCustomer#as_json. `canUpdate` is the policy's verdict when `pundit_user:` is passed, nil otherwise.
export async function importedCustomerJson(row: ImportedCustomer, canUpdate: boolean | null, now: Date = new Date()): Promise<Record<string, unknown>> {
  if (row.purchase_date === null) throw new NotPortedError("ImportedCustomer#as_json", "a customer without a purchase date");
  const product = await productOf(row.link_id);
  const json: Record<string, unknown> = {
    email: row.email,
    created_at: row.created_at.toISOString(),
    timestamp: `${timeAgoInWords(row.purchase_date, now)} ago`,
    link_name: product?.name ?? null,
    product_name: product?.name ?? null,
    price: null,
    is_imported_customer: true,
    purchase_email: row.email,
    id: encrypt(row.id),
  };
  if (product?.licensed) {
    const [license] = await selectRows<Pick<License, "serial">>(
      Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "imported_customer_id")} = ${row.id} LIMIT 1`,
    );
    if (!license) throw new NotPortedError("ImportedCustomer#create_or_get_license", "a licensed product without a license");
    if (license.serial) json.license_key = license.serial;
  }
  json.can_update = canUpdate;
  return json;
}
