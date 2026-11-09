// Ai::StoreAgentObjectFormatter: turns the v2 API JSON into the compact "display objects" the Agent
// chat renders as cards. Pure over the response; the two things Ruby reads from the database (the
// offer code's currency and its coverage sentence) arrive through `DiscountDetailsLookup`, and the
// seller's zone arrives as an IANA name instead of an ActiveSupport::TimeZone.
import { moneyFormatterFormat } from "../models/concerns/money-formatter.ts";

export const MAX_PRODUCT_NAMES = 3;
// OfferCode::DEFAULT_SALE_LABEL
const DEFAULT_SALE_LABEL = "Sale";

export type DisplayField = { label: string; value: string };
export type DisplayObject = {
  type: string;
  title: string;
  subtitle: string | null;
  fields: DisplayField[];
  url: string | null;
  copy: string | number | null;
};

type Json = Record<string, unknown>;

// Resolves [currency_type, coverage] per offer code external id, for the seller's alive codes only.
export type DiscountDetailsLookup = (
  ids: string[],
) => Record<string, { currency: string | null; coverage: string | null }>;

export type FormatOptions = {
  discountDetails?: DiscountDetailsLookup | null;
  // IANA zone for the seller's timezone; null falls back to UTC like Time.zone does by default.
  timeZone?: string | null;
  limit?: number | null;
  existingObjects?: DisplayObject[];
};

const isHash = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
// Ruby truthiness: only nil and false are falsy ("" and 0 are truthy).
const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false;
const isBlank = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === false ||
  (typeof value === "string" && /^[\p{White_Space}]*$/u.test(value)) ||
  (Array.isArray(value) && value.length === 0) ||
  (isHash(value) && Object.keys(value).length === 0);
// Ruby's `.presence`: the value when present, otherwise nil.
const presence = <T>(value: T): T | null => (isBlank(value) ? null : value);
// Narrow a JSON value to what a card field can hold, without asserting types.
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const scalar = (value: unknown): string | number | null =>
  typeof value === "string" || typeof value === "number" ? value : null;
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const hasKey = (json: Json, key: string): boolean => Object.hasOwn(json, key);

// Kernel#Array: nil -> [], Array -> itself, Hash -> its pairs, anything else -> [value].
function rubyArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (isHash(value)) return Object.entries(value);
  return [value];
}

// String#to_i / Integer#to_i: leading integer, 0 when there is none.
function rubyToInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const match = /^\s*[-+]?\d[\d_]*/u.exec(text(value));
  return match ? Number.parseInt(match[0].replaceAll("_", ""), 10) : 0;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isHash(a) && isHash(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => hasKey(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function compactFields(pairs: [string, unknown][]): DisplayField[] {
  const fields: DisplayField[] = [];
  for (const [label, value] of pairs) {
    if (value === null || value === undefined) continue;
    const str = text(value).trim();
    if (str === "") continue;
    fields.push({ label, value: str });
  }
  return fields;
}

// Plain dollars for USD, "<amount> <CCY>" otherwise; the API's formatted_* fields win where present.
export function money(cents: unknown, currency?: unknown): string | null {
  if (cents === null || cents === undefined) return null;
  const dollars = (rubyToInt(cents) / 100).toFixed(2).replace(/\.00$/u, "");
  const ccy = text(truthy(currency) ? currency : "usd").toLowerCase();
  return ccy === "usd" ? `$${dollars}` : `${dollars} ${ccy.toUpperCase()}`;
}

const statusWord = (json: Json, key: string, yes: string, no: string): string | null =>
  hasKey(json, key) ? (truthy(json[key]) ? yes : no) : null;

export function product(json: unknown): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.name) || truthy(json.id))) return null;
  const url = str(presence(json.short_url) ?? presence(json.landing_url));
  const price = str(presence(json.formatted_price) ?? money(json.price, json.currency));
  return {
    type: "product",
    title: text(json.name),
    subtitle: price,
    fields: compactFields([
      ["Status", statusWord(json, "published", "Published", "Unpublished")],
      ["Sales", json.sales_count],
      ["Price", price],
    ]),
    url,
    copy: scalar(presence(url) ?? json.id ?? null),
  };
}

// Time.iso8601 is strict: it raises ArgumentError on anything else, and the card then shows the raw value.
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

// strftime("%b %-d, %Y, %-l:%M %p %Z"). Intl names zones outside the US "GMT+1" where Rails prints "CET".
export function localTime(value: unknown, timeZone: string | null): unknown {
  if (isBlank(value)) return value;
  const raw = text(value);
  const instant = ISO8601.test(raw) ? new Date(raw) : null;
  if (instant === null || Number.isNaN(instant.getTime())) return raw;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

export function discount(
  json: unknown,
  options: { currency?: string | null; coverage?: string | null; timeZone?: string | null } = {},
): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.name) || truthy(json.id))) return null;
  const { currency = null, coverage = null, timeZone = null } = options;
  let amount: string | null = null;
  if (!isBlank(json.percent_off)) amount = `${text(json.percent_off)}% off`;
  else if (!isBlank(json.amount_cents) && !isBlank(currency)) {
    amount = `${moneyFormatterFormat(rubyToInt(json.amount_cents), text(currency), { noCentsIfWhole: true })} off`;
  }
  return {
    type: "discount",
    title: text(json.name),
    subtitle: amount,
    fields: compactFields([
      ["Applies to", coverage],
      ["Apply automatically", statusWord(json, "auto_apply", "On", "Off")],
      ["Sale label", truthy(json.auto_apply) ? (presence(json.sale_label) ?? DEFAULT_SALE_LABEL) : null],
      ["Starts at", localTime(json.valid_at, timeZone)],
      ["Ends at", localTime(json.expires_at, timeZone)],
      ["Times used", json.times_used],
      ["Max uses", json.max_purchase_count],
    ]),
    url: null,
    copy: scalar(presence(json.name) ?? json.id ?? null),
  };
}

function discounts(items: unknown[], options: FormatOptions): DisplayObject[] {
  const limit = options.limit ?? items.length;
  const existing = options.existingObjects ?? [];
  const candidates: Json[] = [];
  for (const item of items) {
    if (isHash(item) && (truthy(item.name) || truthy(item.id)) && !candidates.some((seen) => deepEqual(seen, item)))
      candidates.push(item);
  }

  const cards: DisplayObject[] = [];
  const details: Record<string, { currency: string | null; coverage: string | null }> = {};
  let next = 0;
  // Only complete cards define duplicates; keep going until the unique display budget is full.
  while (cards.length < limit) {
    const batch = candidates.slice(next, next + (limit - cards.length));
    if (batch.length === 0) break;
    next += batch.length;

    const ids = [...new Set(batch.map((item) => presence(item.id)).filter((id): id is string => id !== null))].filter(
      (id) => !hasKey(details, id),
    );
    const found = options.discountDetails && ids.length > 0 ? options.discountDetails(ids) : {};
    for (const id of ids) details[id] = found[id] ?? { currency: null, coverage: null };

    for (const item of batch) {
      const known = details[text(item.id)] ?? { currency: null, coverage: null };
      const card = discount(item, {
        currency: known.currency,
        coverage: known.coverage,
        timeZone: options.timeZone ?? null,
      });
      if (card && !existing.some((other) => deepEqual(other, card)) && !cards.some((other) => deepEqual(other, card)))
        cards.push(card);
    }
  }
  return cards;
}

export function sale(json: unknown): DisplayObject | null {
  if (!isHash(json) || !truthy(json.id)) return null;
  const amount = str(presence(json.formatted_total_price) ?? money(json.price, json.currency));
  return {
    type: "sale",
    title: text(presence(json.product_name) ?? presence(json.email) ?? `Sale ${text(json.id)}`),
    subtitle: amount,
    fields: compactFields([
      ["Buyer", json.email],
      ["Product", json.product_name],
      ["Amount", amount],
      ["Date", json.created_at],
      ["Refunded", statusWord(json, "refunded", "Yes", "No")],
    ]),
    url: null,
    copy: scalar(json.id),
  };
}

export function payout(json: unknown): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.id) || truthy(json.amount) || truthy(json.amount_cents))) return null;
  const amount = str(presence(json.displayable_amount) ?? money(json.amount_cents ?? json.amount, json.currency));
  return {
    type: "payout",
    title: text(presence(amount) ?? "Payout"),
    subtitle: str(presence(json.status)),
    fields: compactFields([
      ["Amount", amount],
      ["Status", json.status],
      ["Paid on", presence(json.paid_at) ?? json.created_at],
    ]),
    url: null,
    copy: scalar(json.id ?? null),
  };
}

export function upsell(json: unknown): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.name) || truthy(json.id))) return null;
  const kind = truthy(json.cross_sell) ? "Cross-sell" : "Upsell";
  return {
    type: "upsell",
    title: text(json.name),
    subtitle: kind,
    fields: compactFields([
      ["Type", kind],
      ["Discount", isHash(json.offer_code) ? json.offer_code.name : json.offer_code],
    ]),
    url: null,
    copy: scalar(json.id ?? null),
  };
}

export function email(json: unknown): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.subject) || truthy(json.name) || truthy(json.id))) return null;
  const status = statusWord(json, "published", "Sent", "Draft");
  const publishedUrl = str(presence(json.published_url));
  return {
    type: "email",
    title: text(presence(json.subject) ?? text(json.name)),
    subtitle: status,
    fields: compactFields([
      ["Status", status],
      ["Audience", json.audience_type],
      ["Published", json.published_at],
    ]),
    url: publishedUrl,
    copy: scalar(publishedUrl ?? json.id ?? null),
  };
}

// ActiveSupport::NumberHelper.number_to_human_size (base 1024, 3 significant digits, trailing zeros dropped).
export function humanSize(value: unknown): string {
  const bytes = rubyToInt(value);
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "Byte" : "Bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length);
  const rounded = Number(size.toPrecision(3));
  return `${rounded} ${units[unit - 1]}`;
}

export function media(json: unknown): DisplayObject | null {
  if (!isHash(json) || !(truthy(json.name) || truthy(json.id))) return null;
  const fileGroup = str(presence(json.file_group));
  const url = str(presence(json.url));
  return {
    type: "media",
    title: text(json.name),
    subtitle: fileGroup === null ? null : fileGroup.charAt(0).toUpperCase() + fileGroup.slice(1).toLowerCase(),
    fields: compactFields([
      ["Type", json.extension],
      ["Size", isBlank(json.file_size) ? null : humanSize(json.file_size)],
    ]),
    url,
    copy: scalar(url ?? json.id ?? null),
  };
}

export function helpArticle(json: unknown): DisplayObject | null {
  if (!isHash(json) || isBlank(json.title)) return null;
  const url = str(presence(json.url));
  return {
    type: "help_article",
    title: text(json.title),
    subtitle: str(presence(json.category)),
    fields: compactFields([["About", json.description]]),
    url,
    copy: scalar(url ?? json.slug ?? null),
  };
}

const compact = <T>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null);
const mapItems = (value: unknown, build: (item: unknown) => DisplayObject | null): DisplayObject[] =>
  compact(rubyArray(value).map(build));
const single = (value: unknown, build: (item: unknown) => DisplayObject | null): DisplayObject[] =>
  compact([build(value)]);

// `endpointId` is Ai::StoreAgentApiCatalog::Endpoint#id.
export function fromResponse(endpointId: string, response: unknown, options: FormatOptions = {}): DisplayObject[] {
  if (options.limit === 0) return [];
  if (!isHash(response)) return [];
  // Never build cards from an error envelope.
  if (response.success === false) return [];

  const nested = (key: string): unknown => (truthy(response[key]) ? response[key] : response);
  switch (endpointId) {
    case "list_products":
      return mapItems(response.products, product);
    case "get_product":
    case "create_product":
    case "update_product":
    case "enable_product":
    case "disable_product":
    case "update_product_sections":
      return single(nested("product"), product);
    case "list_offer_codes":
    case "list_store_offer_codes":
      return discounts(rubyArray(truthy(response.offer_codes) ? response.offer_codes : response.products), options);
    case "get_offer_code":
    case "create_offer_code":
    case "update_offer_code":
    case "get_store_offer_code":
    case "update_store_offer_code":
      return discounts([nested("offer_code")], options);
    case "list_sales":
      return mapItems(response.sales, sale);
    case "get_sale":
    case "refund_sale":
    case "mark_sale_as_shipped":
      return single(nested("sale"), sale);
    case "list_payouts":
      return mapItems(response.payouts, payout);
    case "get_payout":
    case "upcoming_payout":
      return single(nested("payout"), payout);
    case "list_upsells":
      return mapItems(response.upsells, upsell);
    case "get_upsell":
    case "create_upsell":
    case "update_upsell":
      return single(nested("upsell"), upsell);
    case "list_emails":
      return mapItems(truthy(response.emails) ? response.emails : response.installments, email);
    case "get_email":
    case "create_email":
      return single(
        truthy(response.email) ? response.email : truthy(response.installment) ? response.installment : response,
        email,
      );
    case "list_media":
      return mapItems(response.media, media);
    case "upload_media":
      return single(nested("media"), media);
    case "get_help_article":
      return single(nested("help_article"), helpArticle);
    default:
      return [];
  }
}

// Array#to_sentence (the default :en connectors), used for the discount coverage line.
export function toSentence(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}
