// RendersCustomHtmlPages#render_custom_html_products_slice: one catalogue slice for the gumroad:products bridge of a custom HTML
// profile, shared by UsersController#landing_products and PagesController#products.
import { enqueueRoutabilityRefresh, type HostSeller } from "../services/custom-domain-hosts.ts";
import { referencedInPrices } from "../services/pages-product-prices.ts";
import { loadProductsSlice, MAX_ITEMS, profileProductEntries } from "../services/pages-profile-data.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";

const BAD_REQUEST = 400;

// Kernel#Integer(value, exception: false) for what the port can read exactly: plain decimal digits with an optional sign and no
// leading zero (octal), underscore, prefix or blanks. Absent, empty and text that cannot start a literal (not a digit, sign or
// blank) are nil; the rest is Rails'.
export function integerParam(value: unknown): bigint | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw new HandBackToRails("a slice parameter that is not text");
  if (/^[+-]?(0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  if (/^[^\s+\-0-9]/u.test(value)) return null;
  throw new HandBackToRails("a slice parameter Kernel#Integer reads in a way the port does not model");
}

export async function customHtmlProductsSlice(
  seller: HostSeller,
  customHtml: string | null,
  params: Record<string, unknown>,
  now: Date,
): Promise<ActionResult> {
  const badRequest = () => json({ success: false }, BAD_REQUEST);
  const offset = integerParam(params.offset);
  const requested = integerParam(params.limit);
  if (offset === null || offset < 0n || requested === null || requested < 1n) return badRequest();

  // The prices half (visitor GeoIP and currency) is Rails'.
  if (referencedInPrices(customHtml))
    throw new HandBackToRails("a catalogue slice of a page that references product prices");
  const limit = requested < BigInt(MAX_ITEMS) ? Number(requested) : MAX_ITEMS;
  const slice = await loadProductsSlice(seller, now, { offset, limit });
  if (slice === null) return badRequest();
  const body = json({
    success: true,
    offset: Number(offset),
    limit,
    products: profileProductEntries(slice.products),
    products_total: slice.total,
    prices: {},
  });
  await enqueueRoutabilityRefresh(slice.routabilityRefresh);
  return { ...body, headers: { "Cache-Control": "private, no-store" } };
}
