// Port of Installment#audience_members_filter_params (app/models/installment.rb): a post's saved filters, turned into the
// params AudienceMember.filter takes. Golden: __fixtures__/audience-member-filter.golden.json (filter_params_cases).
//
// Values Node would have to guess at throw NotPortedError, as with-filtering.ts does: a filter written in a type the
// editor does not write, a date Ruby's lenient Date.parse reads but ISO 8601 does not, a variant id that does not decode,
// and an "opened" or "has not clicked" reference to a post of the seller's (they ask DynamoDB).
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import type { FilterParams } from "./audience-member.ts";
import type { YamlValue } from "./concerns/psych.ts";
import { endOfDayIso8601, startOfDayIso8601 } from "./concerns/rails-time-zone.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
import { clickedRecipientPurchaseIds, openedRecipientPurchaseIds } from "./email-engagement-store.ts";
import type { InstallmentPost } from "./installment-post.ts";
import { nilReceiver } from "./offer-code.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";
import { castBoolean, filterValue, parseJsonData } from "./with-filtering.ts";

const SOURCE = "installment.rb";
const refuse = (what: string): never => {
  throw new NotPortedError(what, SOURCE);
};

function stringList(value: YamlValue, key: string): string[] {
  if (!Array.isArray(value)) return refuse(`${key} that is not a list`);
  return value.map((item) => (typeof item === "string" ? item : refuse(`${key} with a value that is not a string`)));
}

const MIN_FILTER_YEAR = 1000;
const MAX_FILTER_YEAR = 9999;
const FILTER_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

// `safe_parse_filter_date(value)`: the calendar date a stored filter names, or null for no date. Only the ISO 8601
// forms the filters are stored in are read; `Date.parse` accepts many more.
function safeParseFilterDate(value: YamlValue): { year: number; month: number; day: number } | null {
  if (value === null) return null;
  if (typeof value !== "string") return refuse("a filter date that is not a string");
  const match = FILTER_DATE.exec(value);
  if (match === null) return refuse("a filter date that is not ISO 8601");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (year < MIN_FILTER_YEAR || year > MAX_FILTER_YEAR) return null;
  return { year, month, day };
}

// `seller.products.where(unique_permalink: permalinks).ids`
async function productIds(sellerId: number | bigint, permalinks: string[]): Promise<number[]> {
  const permalink = column("links", "unique_permalink");
  const condition =
    permalinks.length === 1
      ? Prisma.sql`${permalink} = ${permalinks[0]}`
      : Prisma.sql`${permalink} IN (${Prisma.join(permalinks, ", ")})`;
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${condition}`,
  );
  return rows.map((row) => Number(row.id));
}

// `compact_blank!`
const compactBlank = (params: FilterParams): FilterParams =>
  Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) =>
        !(
          value === null ||
          value === undefined ||
          value === false ||
          (typeof value === "string" && value.trim() === "") ||
          (Array.isArray(value) && value.length === 0)
        ),
    ),
  ) as FilterParams;

async function timezoneOf(post: InstallmentPost): Promise<string> {
  const user = await post.seller();
  if (user === null) throw nilReceiver("timezone");
  return user.timezone ?? refuse("a seller without a time zone");
}

// `audience_members_filter_params` up to the behavior filters: a post that names `opened_post_id` or `not_clicked_post_id` keeps
// them out of the result, for `behaviorFilterParams` to resolve.
async function filterParamsBeforeBehavior(post: InstallmentPost): Promise<FilterParams> {
  const json = { jsonData: () => parseJsonData(post.row.json_data) };
  const value = (key: string) => filterValue(json, key);
  const params: FilterParams = {};

  if (post.sellerOrProductOrVariantType) params.type = "customer";
  else if (post.followerType) params.type = "follower";
  else if (post.affiliateType) params.type = "affiliate";

  const seller = async () =>
    (await post.seller()) ??
    (() => {
      throw nilReceiver("products");
    })();
  const permalinkIds = async (key: string) => productIds((await seller()).id, stringList(value(key), key));

  if (value("bought_products") !== null) params.bought_product_ids = await permalinkIds("bought_products");
  if (value("not_bought_products") !== null) params.not_bought_product_ids = await permalinkIds("not_bought_products");
  const variants = (key: string) =>
    value(key) === null
      ? null
      : stringList(value(key), key).map((id) => decrypt(id) ?? refuse("a variant external id that does not decode"));
  params.bought_variant_ids = variants("bought_variants");
  params.not_bought_variant_ids = variants("not_bought_variants");
  const cents = (key: string) => {
    const amount = value(key);
    return amount === null ? null : typeof amount === "number" ? amount : refuse(`${key} that is not a number`);
  };
  params.paid_more_than_cents = cents("paid_more_than_cents");
  params.paid_less_than_cents = cents("paid_less_than_cents");
  if (post.sellerOrProductOrVariantType && castBoolean(value("active_customers_only")) === true)
    params.active_customers_only = true;
  const licenseUses = value("minimum_license_uses");
  if (post.sellerOrProductOrVariantType && licenseUses !== null) {
    const uses =
      typeof licenseUses === "string"
        ? rubyToI(licenseUses)
        : typeof licenseUses === "number"
          ? Math.trunc(licenseUses)
          : refuse("minimum_license_uses that is not a number");
    if (uses > 0) params.minimum_license_uses = uses;
  }
  const createdAfter = safeParseFilterDate(value("created_after"));
  if (createdAfter !== null)
    params.created_after = startOfDayIso8601(
      await timezoneOf(post),
      createdAfter.year,
      createdAfter.month,
      createdAfter.day,
    );
  const createdBefore = safeParseFilterDate(value("created_before"));
  if (createdBefore !== null)
    params.created_before = endOfDayIso8601(
      await timezoneOf(post),
      createdBefore.year,
      createdBefore.month,
      createdBefore.day,
    );
  const boughtFrom = value("bought_from");
  if (boughtFrom !== null)
    params.bought_from = typeof boughtFrom === "string" ? boughtFrom : refuse("bought_from that is not a string");
  if (value("affiliate_products") !== null) params.affiliate_product_ids = await permalinkIds("affiliate_products");
  if (value("waitlisted_products") !== null) {
    const ids = await permalinkIds("waitlisted_products");
    // An unresolved selection must match nobody: compact_blank! would drop an empty list and send to every follower.
    params.waitlisted_product_ids = ids.length > 0 ? ids : [null];
  }
  return params;
}

export async function audienceMembersFilterParams(post: InstallmentPost): Promise<FilterParams> {
  const params = await filterParamsBeforeBehavior(post);
  const json = { jsonData: () => parseJsonData(post.row.json_data) };
  if (filterValue(json, "opened_post_id") !== null) refuse("an opened filter (DynamoDB)");
  if (filterValue(json, "not_clicked_post_id") !== null) refuse("a has-not-clicked filter (DynamoDB)");
  return compactBlank(params);
}

// `seller.installments.find_by_external_id(ref)`: unlike the dashboard lookups, a deleted post still resolves.
async function sellerOwnsPost(sellerId: number | bigint, reference: YamlValue): Promise<boolean> {
  if (typeof reference !== "string") return refuse("a behavior filter reference that is not a string");
  const id = decrypt(reference);
  if (id === null) return false;
  const rows = await selectRows(
    Prisma.sql`SELECT ${column("installments", "id")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${sellerId} AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  return rows.length > 0;
}

export type BehaviorAudience =
  // Neither `opened_post_id` nor `not_clicked_post_id` is set: `displayed_audience_members_count` is the plain count.
  | { kind: "unfiltered" }
  // A reference that is not one of the seller's posts leaves `include_emails: [""]`, which matches nobody: a count of 0,
  // below the floor, so `displayed_audience_members_count` is nil.
  | { kind: "withheld" }
  // Every reference resolves to one of the seller's posts: the count reads their opens or clicks from DynamoDB.
  | { kind: "engagement"; opened: string | null; notClicked: string | null };

export async function behaviorAudience(post: InstallmentPost): Promise<BehaviorAudience> {
  const json = { jsonData: () => parseJsonData(post.row.json_data) };
  const opened = filterValue(json, "opened_post_id");
  const notClicked = filterValue(json, "not_clicked_post_id");
  const references = [opened, notClicked].filter((reference) => reference !== null);
  if (references.length === 0) return { kind: "unfiltered" };
  const sellerId = post.row.seller_id ?? refuse("a post without a seller");
  const owned = await Promise.all(references.map((reference) => sellerOwnsPost(sellerId, reference)));
  if (!owned.every(Boolean)) return { kind: "withheld" };
  return {
    kind: "engagement",
    opened: opened === null ? null : String(opened),
    notClicked: notClicked === null ? null : String(notClicked),
  };
}

const PURCHASE_LOOKUP_BATCH_SIZE = 1000;

// `purchase_emails_for(purchase_ids)`: the downcased addresses of those purchases, without repeats.
async function purchaseEmails(purchaseIds: number[]): Promise<string[]> {
  const emails = new Set<string>();
  for (let start = 0; start < purchaseIds.length; start += PURCHASE_LOOKUP_BATCH_SIZE) {
    const slice = purchaseIds.slice(start, start + PURCHASE_LOOKUP_BATCH_SIZE);
    const rows = await selectRows<{ email: string | null }>(
      Prisma.sql`SELECT ${column("purchases", "email")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} IN (${Prisma.join(slice, ", ")})`,
    );
    for (const { email } of rows) if (email !== null) emails.add(email.toLowerCase());
  }
  return [...emails];
}

// The `include_emails` or `exclude_emails` of `audience_members_filter_params` for a post that names exactly one of the two
// behavior filters, plus the params without them (what the count's wider audience is read from).
export async function behaviorFilterParams(
  post: InstallmentPost,
  behavior: Extract<BehaviorAudience, { kind: "engagement" }>,
): Promise<{ params: FilterParams; wider: FilterParams } | null> {
  if (behavior.opened !== null && behavior.notClicked !== null) return null;
  const wider = compactBlank(await filterParamsBeforeBehavior(post));
  const params: FilterParams = { ...wider };
  if (behavior.opened !== null) {
    const emails = await purchaseEmails(
      await openedRecipientPurchaseIds(decrypt(behavior.opened) ?? refuse("an opened post id")),
    );
    // An empty opener list must match nobody: `compact_blank!` would drop it and count everyone.
    params.include_emails = emails.length > 0 ? emails : [""];
  } else if (behavior.notClicked !== null) {
    const emails = await purchaseEmails(
      await clickedRecipientPurchaseIds(decrypt(behavior.notClicked) ?? refuse("a clicked post id")),
    );
    if (emails.length > 0) params.exclude_emails = emails;
  }
  return { params, wider };
}
