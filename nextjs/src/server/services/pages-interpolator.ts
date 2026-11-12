// Port of Pages::Interpolator (app/services/pages/interpolator.rb): `interpolate_profile` in full, and the product half
// (`interpolate`) for the markers that need only the product's name, description and review summary.
import {
  allElements,
  getAttribute,
  insertBefore,
  isEmptyTag,
  removeNode,
  type ElementNode,
  type TextNode,
} from "../html/libxml2-tree.ts";
import { fragmentToHtml, html4Fragment } from "../html/loofah.ts";
import { sanitize } from "../html/sanitizer.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

export type ProfileFields = { name_or_username: string | null; bio: string | null };
export type PriceEntry = {
  price?: string | null;
  original_price?: string | null;
  currency_code?: string | null;
  options?: (PriceEntry & { name: string })[];
};
export type ProductPrices = Record<string, PriceEntry>;

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

// ---- Pages::Interpolator.interpolate (the product half) ----
//
// The caller resolves what Ruby reads off the product: its name, description, and the review summary (null when reviews are hidden
// or none exist yet: `review_summary`). A marker that needs the product's formatted price or its options' prices, and every buy
// button (Pages::BuyButtonParams), stay in Rails: the port throws before it reads anything else.
export type ProductFields = {
  name: string | null;
  description: string | null;
  reviews: { average: number; count: number } | null;
};

// Pages::Interpolator::DESCRIPTION_SANITIZE_OPTIONS
const DESCRIPTION_SANITIZE_OPTIONS = {
  tags: ["p", "br", "h1", "h2", "h3", "strong", "em", "ul", "li", "a"],
  attributes: ["href"],
};
// Pages::Interpolator::PHRASING_ONLY_MARKER_TAGS
const PHRASING_ONLY_MARKER_TAGS = new Set(["p", "span", "a", "em", "strong", "b", "i", "small", "label"]);
// Pages::Interpolator::DESCRIPTION_BLOCK_TAGS (Ruby's \s is ASCII)
const DESCRIPTION_BLOCK_TAGS = /<(?:p|h1|h2|h3|ul)[\t-\r >]/u;

// What `inner_html = value` leaves for sanitized text: the three entities the serializer writes decode back to the text they came from,
// and anything with a tag or another reference is a context-dependent parse left to Rails.
function sanitizedTextOnly(value: string): string {
  if (value.includes("<")) throw new NotPortedError("Pages::Interpolator writing sanitized markup into an element");
  if (/&(?!(?:amp|lt|gt);)/u.test(value)) {
    throw new NotPortedError("Pages::Interpolator writing a character reference into an element");
  }
  return value.replace(/&(?:amp|lt|gt);/gu, (match) => (match === "&amp;" ? "&" : match === "&lt;" ? "<" : ">"));
}

export function interpolateProduct(html: string, product: ProductFields): string {
  if (blank(html)) return html;
  // `return if stats[:count].zero?`
  const reviews = product.reviews !== null && product.reviews.count !== 0 ? product.reviews : null;
  const fragment = html4Fragment(html);
  let sanitizedDescription: string | undefined;
  for (const node of allElements(fragment)) {
    const field = getAttribute(node, "data-gumroad-field");
    if (field === undefined) continue;
    const name = field ?? "";
    let value: string | null;
    let raw = false;
    if (name === "price") {
      throw new NotPortedError("Pages::Interpolator writing the product's formatted price");
    } else if (name === "name") {
      value = product.name ?? "";
    } else if (name === "description") {
      sanitizedDescription ??= sanitize(product.description ?? "", DESCRIPTION_SANITIZE_OPTIONS);
      value = sanitizedDescription;
      raw = true;
    } else if (name === "rating") {
      value = reviews === null ? null : String(reviews.average);
    } else if (name === "review-count") {
      value = reviews === null ? null : String(reviews.count);
    } else {
      continue;
    }
    if (value === null) continue;
    if (raw && PHRASING_ONLY_MARKER_TAGS.has(node.name) && DESCRIPTION_BLOCK_TAGS.test(value)) {
      // node.replace(Loofah.fragment(value).children): the marker's own attributes are lost with it.
      insertBefore(node, [...html4Fragment(value).children]);
      removeNode(node);
    } else {
      writeText(node, raw ? sanitizedTextOnly(value) : value);
    }
  }
  if (allElements(fragment).some((node) => getAttribute(node, "data-gumroad-action") === "buy")) {
    throw new NotPortedError("Pages::Interpolator validating a buy button");
  }
  return fragmentToHtml(fragment);
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
