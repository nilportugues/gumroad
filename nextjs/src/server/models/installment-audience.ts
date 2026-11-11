// Port of Installment#audience_members_filter_params (app/models/installment.rb): a post's saved filters, turned into the
// params AudienceMember.filter takes. Golden: __fixtures__/audience-member-filter.golden.json (filter_params_cases).
//
// Values Node would have to guess at throw NotPortedError, as with-filtering.ts does: a filter written in a type the
// editor does not write, a date Ruby's lenient Date.parse reads but ISO 8601 does not, a variant id that does not decode,
// and a "has not clicked" reference (it asks DynamoDB).
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import type { FilterParams } from "./audience-member.ts";
import type { YamlValue } from "./concerns/psych.ts";
import { endOfDayIso8601, startOfDayIso8601 } from "./concerns/rails-time-zone.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
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

export async function audienceMembersFilterParams(post: InstallmentPost): Promise<FilterParams> {
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
  if (value("not_clicked_post_id") !== null) refuse("a has-not-clicked filter (DynamoDB)");

  return compactBlank(params);
}
