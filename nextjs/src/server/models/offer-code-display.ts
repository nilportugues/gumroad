// What a sale's JSON prints of its offer code: `offer_code.code` and `OfferCode#displayed_amount_off(link.price_currency_type, with_symbol: true)`
// of the code as it is now. A purchase with a cached discount (`purchase_offer_code_discount`) prints the discount's copy instead.
import { Prisma } from "@prisma/client";

import { moneyFormatWithGemSymbol } from "./concerns/money-formatter.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type OfferCodeRow = { id: bigint; code: string | null; amount_cents: number | null; amount_percentage: number | null };

export type OfferCodeDisplay = { code: string | null; displayed_amount_off: string };

const fail = (what: string): never => {
  throw new NotPortedError(what, "Purchase#as_json");
};

// OfferCode#displayed_amount_off for a code in cents on a product priced in USD, or a percentage.
export function displayedAmountOff(offerCode: OfferCodeRow, productCurrency: string | null): string {
  if (offerCode.amount_cents !== null) {
    if (productCurrency?.toLowerCase() !== "usd")
      fail("an offer code in cents on a product priced in another currency");
    return moneyFormatWithGemSymbol(offerCode.amount_cents, "usd", { noCentsIfWhole: true });
  }
  if (offerCode.amount_percentage === null) fail("an offer code with no amount");
  return `${offerCode.amount_percentage}%`;
}

// A purchases row, or a Prisma Purchase.
type PurchaseIds = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Offer codes of purchases by id; `purchases` that have none are left out. A cached discount or a missing code row is not served.
export async function offerCodeDisplays(
  purchases: PurchaseIds[],
  currencyOfProduct: (linkId: bigint | number | null) => string | null,
): Promise<Map<string, OfferCodeDisplay>> {
  const coded = purchases.filter((purchase) => purchase.offer_code_id != null);
  const result = new Map<string, OfferCodeDisplay>();
  if (coded.length === 0) return result;
  const discounts = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("purchase_offer_code_discounts")} WHERE ${column("purchase_offer_code_discounts", "purchase_id")} IN (${Prisma.join(coded.map((purchase) => purchase.id))}) LIMIT 1`,
  );
  if (discounts.length > 0) fail("an offer code with a cached discount");
  const codes = await selectRows<OfferCodeRow>(
    Prisma.sql`SELECT ${column("offer_codes", "id")}, ${column("offer_codes", "code")}, ${column("offer_codes", "amount_cents")}, ${column("offer_codes", "amount_percentage")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "id")} IN (${Prisma.join(coded.map((purchase) => purchase.offer_code_id!))})`,
  );
  const byId = new Map(codes.map((row) => [String(row.id), row]));
  for (const purchase of coded) {
    const offerCode = byId.get(String(purchase.offer_code_id)) ?? fail("an offer code whose row is missing");
    result.set(String(purchase.id), {
      code: offerCode.code,
      displayed_amount_off: displayedAmountOff(offerCode, currencyOfProduct(purchase.link_id)),
    });
  }
  return result;
}
