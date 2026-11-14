// RendersCustomHtmlPages#render_custom_html_products_slice: one catalogue slice for the gumroad:products bridge of a custom HTML
// profile, shared by UsersController#landing_products and PagesController#products.
import { enqueueRoutabilityRefresh, type HostSeller } from "../services/custom-domain-hosts.ts";
import { referencedInPrices } from "../services/pages-product-prices.ts";
import { loadProductsSlice, MAX_ITEMS, profileProductEntries } from "../services/pages-profile-data.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";

const BAD_REQUEST = 400;

// Kernel#Integer(value, exception: false) for a text parameter: ASCII white space around the number, an optional sign, a 0x, 0b, 0o or
// 0d prefix or a leading 0 for octal, and single underscores between digits. Anything else is nil, as in Ruby; a null byte is Rails'.
const DIGITS = (digit: string) => `${digit}+(?:_${digit}+)*`;
const KERNEL_INTEGER = new RegExp(
  `^[\\t-\\r ]*([+-])?(?:0([xX])(${DIGITS("[0-9a-fA-F]")})|0([bB])(${DIGITS("[01]")})|0([oO])(${DIGITS("[0-7]")})|0([dD])(${DIGITS("[0-9]")})|(0(?:_?[0-7]+)*)|([1-9][0-9]*(?:_[0-9]+)*))[\\t-\\r ]*$`,
  "u",
);

export function integerParam(value: unknown): bigint | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw new HandBackToRails("a slice parameter that is not text");
  if (value.includes("\u0000")) throw new HandBackToRails("a slice parameter with a null byte");
  const match = KERNEL_INTEGER.exec(value);
  if (match === null) return null;
  const [, sign, , hex, , binary, , octal, , decimal, leadingZero, plain] = match;
  const digits = (text: string | undefined, prefix: string) => BigInt(prefix + (text ?? "").replaceAll("_", ""));
  let magnitude: bigint;
  if (hex !== undefined) magnitude = digits(hex, "0x");
  else if (binary !== undefined) magnitude = digits(binary, "0b");
  else if (octal !== undefined) magnitude = digits(octal, "0o");
  else if (decimal !== undefined) magnitude = digits(decimal, "");
  else if (leadingZero !== undefined) magnitude = digits(leadingZero, "0o");
  else magnitude = digits(plain, "");
  return sign === "-" ? -magnitude : magnitude;
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
