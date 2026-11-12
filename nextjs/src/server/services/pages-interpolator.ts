// Port of Pages::Interpolator.interpolate_profile (app/services/pages/interpolator.rb): the profile half, which fills display fields
// of a seller's custom HTML. The product half (`interpolate`) also needs the product's formatted price, its review stats and
// Pages::BuyButtonParams, and is not ported.
import { allElements, getAttribute, isEmptyTag, type ElementNode, type TextNode } from "../html/libxml2-tree.ts";
import { fragmentToHtml, html4Fragment } from "../html/loofah.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

export type ProfileFields = { name_or_username: string | null; bio: string | null };
export type PriceEntry = {
  price?: string | null;
  original_price?: string | null;
  currency_code?: string | null;
  options?: PriceEntry[] & { name?: string }[];
};
export type ProductPrices = Record<string, PriceEntry & { options?: (PriceEntry & { name: string })[] }>;

// `String#blank?`: [[:space:]] is Unicode White_Space.
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const blank = (value: string | null | undefined) => value == null || BLANK.test(value);

// `inner_html = ERB::Util.h(text)` parses the escaped text in the marker's context, which leaves a single text node for these
// containers and these characters. Anything else (void and raw-text elements, tables and lists, which drop or move whitespace, and
// control characters) is left to Rails.
const TEXT_CONTAINERS = new Set(
  "a abbr article aside b blockquote button cite code div em figcaption footer h1 h2 h3 h4 h5 h6 header i label li main nav p s section small span strong sub sup time u".split(
    " ",
  ),
);
// eslint-disable-next-line no-control-regex -- the point is to find them
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

const PROFILE_FIELDS: Record<string, (profile: ProfileFields) => string> = {
  name: (profile) => profile.name_or_username ?? "",
  bio: (profile) => profile.bio ?? "",
};

type PriceLookup = { price?: string | null; original_price?: string | null; currency_code?: string | null };
const PRODUCT_PRICE_FIELDS: Record<string, (entry: PriceLookup) => string | null | undefined> = {
  price: (entry) => entry.price,
  "original-price": (entry) => entry.original_price,
  // Uppercased for markup, empty when the code is missing (`.upcase.presence`).
  currency: (entry) => (entry.currency_code ?? "").toUpperCase(),
};

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

function writeText(node: ElementNode, text: string): void {
  if (
    !TEXT_CONTAINERS.has(node.name) ||
    isEmptyTag(node.name) ||
    UNSAFE_TEXT.test(text) ||
    (text !== "" && blank(text))
  )
    throw new NotPortedError("Pages::Interpolator writing into this element or text");
  const child: TextNode = { type: "text", content: text, parent: node };
  node.children = text === "" ? [] : [child];
}

export function interpolateProfile(html: string, options: { profile: ProfileFields; prices?: ProductPrices }): string {
  if (blank(html)) return html;
  const { profile, prices } = options;
  const fragment = html4Fragment(html);
  for (const node of allElements(fragment)) {
    const field = getAttribute(node, "data-gumroad-field");
    if (field === undefined) continue;
    // A valueless attribute reads as an empty string in Nokogiri, so it still scopes the marker to a product.
    const permalink = getAttribute(node, "data-gumroad-product");
    if (permalink !== undefined) {
      let entry: PriceLookup | undefined = own(prices, permalink ?? "");
      const option = getAttribute(node, "data-gumroad-option");
      if (entry && !blank(option)) {
        const wanted = option!;
        entry = (own(prices, permalink ?? "")?.options ?? []).find((candidate) => candidate.name === wanted);
      }
      const handler = own(PRODUCT_PRICE_FIELDS, field ?? "");
      const value = entry && handler ? handler(entry) : null;
      // An unknown permalink or field leaves the element untouched.
      if (value != null && !blank(value)) writeText(node, value);
    } else {
      const handler = own(PROFILE_FIELDS, field ?? "");
      if (handler) writeText(node, handler(profile));
    }
  }
  return fragmentToHtml(fragment);
}
