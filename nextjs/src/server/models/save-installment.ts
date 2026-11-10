// SaveInstallmentService (app/services/save_installment_service.rb): creating and updating a post from the Emails form.
// Golden: __fixtures__/save-installment.golden.json (scripts/golden/save-installment.rb), every statement, Sidekiq push and
// Elasticsearch request of the real service.
//
// What Node cannot prove throws NotPortedError before the first write, and the controller hands the request to Rails:
// a post with files (S3 and ProductFile), a message Nokogiri would rewrite or that holds an upsell card,
// a preview email, a "has not clicked" filter, a call to action, and the date formats TimeZone#parse reads beyond ISO 8601.
import { Prisma, type BaseVariant, type Installment, type InstallmentRule, type Link, type User } from "@prisma/client";

import { randomBytes } from "node:crypto";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { dateInTimeZoneIso8601, endOfDayIso8601, startOfDayIso8601 } from "./concerns/rails-time-zone.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { jsonData, setJsonDataForAttr } from "./concerns/json-data.ts";
import { parseIsoDate } from "./concerns/ruby-time.ts";
import { nokogiriRoundtrip } from "./html-fragment.ts";
import { InstallmentFlags } from "./installment-post.ts";
import { InstallmentRules, markDeletedBang as markRuleDeletedBang } from "./installment-rule-writes.ts";
import { InstallmentInvalid, Installments, post, publishBang } from "./installment-writes.ts";
import { enqueueLinkIndexUpdate } from "./link.ts";
import { findOneBy } from "./row-reads.ts";
import { createBlastAndEnqueue, hasBeenBlasted } from "./post-email-blast.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { transaction } from "./runtime/transaction.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { updateProfilePostsSections } from "./seller-profile-sections.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { eligibleToSendEmails, MINIMUM_SALES_CENTS_VALUE } from "./user-email-eligibility.ts";
import { NotPortedError } from "./user.ts";
import { castBoolean, AUDIENCE_TYPE, FOLLOWER_TYPE, PRODUCT_TYPE, SELLER_TYPE, VARIANT_TYPE } from "./with-filtering.ts";

type InstallmentRecord = ModelRecord<Installment>;
type Scalar = string | number | boolean | null;
export type RequestParams = Record<string, unknown>;
export type FilterParams = Record<string, unknown>;

export class PreviewEmailError extends Error {}

const SOURCE = "save_installment_service.rb";
const refuse = (what: string): never => {
  throw new NotPortedError(what, SOURCE);
};

// `BaseVariant.find_by_external_id(id)&.id`: an id that does not decrypt looks up `id IS NULL` (no row), and `nil.to_s` decodes like "".
export async function findBaseVariantId(externalId: unknown): Promise<number | null> {
  if (externalId !== undefined && externalId !== null && typeof externalId !== "string") return refuse("a variant_external_id that is not text");
  const variant = await findOneBy<BaseVariant>("BaseVariant", "id", decrypt(externalId ?? ""), true);
  return variant === null ? null : Number(variant.id);
}

// installment_params: `params.require(:installment).permit(...)`, in the order of the permit list.
const SCALAR_KEYS = [
  "name",
  "message",
  "installment_type",
  "link_id",
  "paid_more_than_cents",
  "paid_less_than_cents",
  "created_after",
  "created_before",
  "bought_from",
  "active_customers_only",
  "minimum_license_uses",
  "shown_on_profile",
  "send_emails",
  "allow_comments",
  "not_clicked_post_id",
] as const;
const ARRAY_KEYS = ["bought_products", "bought_variants", "affiliate_products", "not_bought_products", "not_bought_variants", "waitlisted_products", "shown_in_profile_sections"] as const;
export type Permitted = Partial<Record<(typeof SCALAR_KEYS)[number], Scalar>> & Partial<Record<(typeof ARRAY_KEYS)[number], string[]>>;

const isScalar = (value: unknown): value is Scalar => value === null || ["string", "number", "boolean"].includes(typeof value);
const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// ActionController::Parameters#permit: scalars first, then the lists of scalars, each in the order of the permit list.
export function permit(raw: unknown, scalarKeys: readonly string[], arrayKeys: readonly string[]): Record<string, unknown> {
  if (!isHash(raw)) return refuse("a parameter that is not a hash");
  const out: Record<string, unknown> = {};
  for (const key of scalarKeys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === "number" && !Number.isInteger(value)) refuse("a float parameter");
    if (isScalar(value)) out[key] = value;
  }
  for (const key of arrayKeys) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    if (value.some((item) => item === null)) refuse("a nil in a list parameter");
    if (value.every((item) => isScalar(item))) out[key] = value;
  }
  return out;
}

export const permitInstallment = (raw: unknown): Permitted => permit(raw, SCALAR_KEYS, ARRAY_KEYS) as Permitted;

// ActiveSupport's Object#present?
export function present(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return /[^\s]/u.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
const presence = <T>(value: T): T | null => (present(value) ? value : null);
const wrap = (value: unknown): unknown[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

// FlagShihTzu::TRUE_VALUES
const TRUE_VALUES = [true, 1, "1", "t", "T", "true", "TRUE"];
const setFlag = (record: InstallmentRecord, name: Parameters<typeof InstallmentFlags.set>[1], value: unknown) =>
  record.set("flags", Number(InstallmentFlags.set(record.get("flags"), name, TRUE_VALUES.includes(value as never))));

const FILTER_KEYS = new Set(["paid_more_than_cents", "paid_less_than_cents", "created_after", "created_before", "bought_from", "active_customers_only", "minimum_license_uses", "not_clicked_post_id"]);
const FILTER_LISTS = new Set(["bought_products", "bought_variants", "affiliate_products", "not_bought_products", "not_bought_variants", "waitlisted_products"]);

function asString(value: Scalar | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : refuse("a text parameter that is not a string");
}

// `installment.assign_attributes(attrs)` / `build(attrs)`: the writers of the permitted keys, in order.
function assign(record: InstallmentRecord, attrs: Permitted, keys: readonly string[]): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (!keys.includes(key)) continue;
    if (key === "name" || key === "message" || key === "installment_type") record.set(key, asString(value as Scalar));
    else if (key === "link_id") record.set("link_id", value === null ? null : rubyToI(value));
    else if (key === "shown_on_profile" || key === "send_emails" || key === "allow_comments") setFlag(record, key, value);
    // json_data is read and written through its accessors, which leave the attribute's place in `attributes` alone.
    else if (FILTER_KEYS.has(key) || FILTER_LISTS.has(key)) record.untracked(() => setJsonDataForAttr(record, key, value as never));
  }
}

// ----- WithFiltering#add_and_validate_filters

const compareFailed = (a: unknown, b: unknown) => new Error(`comparison of ${typeof a === "string" ? "String" : "Integer"} with ${typeof b === "string" ? "String" : "Integer"} failed`);

function greater(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    // eslint-disable-next-line no-control-regex
    if (/[^\u0000-\u007f]/u.test(a + b)) refuse("a price filter with non-ASCII text");
    return a > b;
  }
  if (typeof a === "number" && typeof b === "number") return a > b;
  throw compareFailed(a, b);
}

// `safe_parse_filter_date`: the ISO dates the form sends. Any other text Date.parse reads is left to Rails.
function safeParseFilterDate(value: unknown): { year: number; month: number; day: number } | null {
  if (!present(value)) return null;
  const text = typeof value === "string" ? value : refuse("a filter date that is not text");
  if (!/^\s*\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$/u.test(text)) return refuse("a filter date in a format Date.parse reads");
  let date;
  try {
    date = parseIsoDate(text.trim().slice(0, 10).replace(/(\d{4})-(\d)-/u, "$1-0$2-").replace(/-(\d)$/u, "-0$1"));
  } catch {
    return null;
  }
  return date.year < 1000 || date.year > 9999 ? null : date;
}

// BigDecimal(value.to_s) * unit_scaling_factor for the dollar amounts a workflow form sends; only USD sellers, whose cents need no conversion.
function priceFilterCents(value: unknown, currency: string): number | null {
  if (currency !== "usd") return refuse("a price filter in a currency other than USD");
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof value === "string" ? value : refuse("a price filter that is not an integer or text");
  const match = /^\s*(-?)(\d+)(?:\.(\d+))?\s*$/u.exec(text);
  if (match === null) return refuse("a price filter BigDecimal may not read");
  const [, sign, whole, fraction = ""] = match as unknown as [string, string, string, string?];
  // Beyond 10^13 dollars the cents are not exact doubles; beyond MAX_PRICE_FILTER_MAGNITUDE the filter is dropped.
  if (whole.length > 13) return whole.length > 16 || Number(whole) > 1e15 ? null : refuse("a price filter beyond double precision");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return sign === "-" ? -cents : cents;
}

// Returns false (and adds the error) where Ruby does. Shared with Workflow::ManageService, whose type column is workflow_type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addAndValidateFilters(record: ModelRecord<any>, params: FilterParams, timezone: string, options: { typeColumn?: string; currency?: string } = {}): boolean {
  const type = record.get(options.typeColumn ?? "installment_type") as string | null;
  const audience = type === AUDIENCE_TYPE;
  const follower = type === FOLLOWER_TYPE;
  const sellerish = type === SELLER_TYPE || type === PRODUCT_TYPE || type === VARIANT_TYPE;
  const set = (key: string, value: unknown) => setJsonDataForAttr(record, key, value as never);
  const currency = options.currency ?? "usd";
  const price = (cents: unknown, dollars: unknown) => (!sellerish ? null : present(cents) ? cents : present(dollars) ? priceFilterCents(dollars, currency) : null);
  set("paid_more_than_cents", price(params.paid_more_than_cents, params.paid_more_than));
  set("paid_less_than_cents", price(params.paid_less_than_cents, params.paid_less_than));
  set("bought_products", !audience && present(params.bought_products) ? wrap(params.bought_products) : []);
  set("not_bought_products", present(params.not_bought_products) ? wrap(params.not_bought_products) : []);
  const after = safeParseFilterDate(params.created_after);
  set("created_after", after ? startOfDayIso8601(timezone, after.year, after.month, after.day) : null);
  const before = safeParseFilterDate(params.created_before);
  set("created_before", before ? endOfDayIso8601(timezone, before.year, before.month, before.day) : null);
  set("bought_from", sellerish ? presence((params.bought_from ?? null) as Scalar) : null);
  set("active_customers_only", sellerish ? castBoolean((params.active_customers_only ?? null) as never) : null);
  set("minimum_license_uses", sellerish && present(params.minimum_license_uses) ? presence(Math.max(rubyToI(params.minimum_license_uses), 0)) : null);
  set("bought_variants", !audience && present(params.bought_variants) ? wrap(params.bought_variants) : []);
  set("not_bought_variants", present(params.not_bought_variants) ? wrap(params.not_bought_variants) : []);
  set("affiliate_products", !audience && present(params.affiliate_products) ? wrap(params.affiliate_products) : []);
  set("waitlisted_products", follower && present(params.waitlisted_products) ? wrap(params.waitlisted_products) : []);
  // A post picked by its external id: the filter asks DynamoDB for who clicked it.
  if (present(params.not_clicked_post_id)) refuse("a has-not-clicked audience filter");
  set("not_clicked_post_id", null);
  set("workflow_trigger", sellerish ? presence((params.workflow_trigger ?? null) as Scalar) : null);

  const hash = jsonData(record);
  const value = (key: string) => hash.entries.find(([name]) => name === key)?.[1];
  const more = value("paid_more_than_cents");
  const less = value("paid_less_than_cents");
  if (present(more) && present(less) && greater(more, less)) {
    record.errors.add("base", "Please enter valid paid more than and paid less than values.");
    return false;
  }
  if (after && before && new Date(startOfDayIso8601(timezone, after.year, after.month, after.day)) > new Date(endOfDayIso8601(timezone, before.year, before.month, before.day))) {
    record.errors.add("base", "Please enter valid before and after dates.");
    return false;
  }
  return true;
}

// ----- TimeZone#parse for the `to_be_published_at` the form sends

function parseLocalTime(timezone: string, text: string): Date | null {
  // An explicit offset (the API's ISO 8601 times) names the instant: the seller's zone only reads a time without one.
  const zoned = /^\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})\s*$/u.exec(text);
  if (zoned !== null) {
    const [year, month, day, hour, minute, second] = zoned.slice(1, 7).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59) return null;
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23) return refuse("a publish time Time.new would normalize");
    return new Date(`${text.trim().slice(0, 16)}:${String(second).padStart(2, "0")}${zoned[7]}`);
  }
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*$/u.exec(text);
  if (match === null) return refuse("a publish time in a format TimeZone#parse reads");
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  // Time.new raises ArgumentError (rescued as "not a date") for these; the rest it normalizes (Feb 30 is Mar 2), which Node leaves to Rails.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23) return refuse("a publish time Time.new would normalize");
  return new Date(dateInTimeZoneIso8601(timezone, year, month, day, hour * 3600 + minute * 60 + second));
}

// `published_at` strings: ISO 8601 with a zone designator.
function isoDate(text: string): { instant: Date; day: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(text);
  const instant = new Date(text);
  if (match === null || Number.isNaN(instant.getTime())) return refuse("a publish date in a format Rails casts differently");
  return { instant, day: match[1]! };
}

// ----- the service

export type SaveInstallmentDeps = { now: () => Date; hex4: () => string; notify: (error: unknown) => void };
const defaultDeps: SaveInstallmentDeps = { now: () => new Date(), hex4: () => randomBytes(4).toString("hex"), notify: (error) => notifyError(error) };

export type SaveInstallmentResult = { ok: boolean; error: string | null; installment: InstallmentRecord | null };

const isDatabaseDuplicate = (error: unknown, index: string) => (error as { code?: string; message?: string } | null)?.code === "P2002" && String((error as Error).message).includes(index);

export async function saveInstallment(
  input: { seller: User; params: RequestParams; installment: InstallmentRecord | null },
  overrides: Partial<SaveInstallmentDeps> = {},
): Promise<SaveInstallmentResult> {
  const deps = { ...defaultDeps, ...overrides };
  const { seller, params } = input;
  let installment = input.installment;
  let error: string | null = null;

  if (!isHash(params.installment)) return refuse("a request without an installment parameter");
  const ip = permitInstallment(params.installment);
  const attrs: readonly string[] = Object.keys(ip).filter((key) => key !== "shown_in_profile_sections");
  const productOrVariant = ip.installment_type === PRODUCT_TYPE || ip.installment_type === VARIANT_TYPE;

  // set_product_and_enforce_ownership
  let product: Link | null = null;
  if (productOrVariant) {
    if (present(ip.link_id)) {
      const permalink = typeof ip.link_id === "string" ? ip.link_id : refuse("a product id that is not text");
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
      );
      product = row ? castRow<Link>("Link", row) : null;
    }
    if (product === null) error = "Product not found";
  }
  if (error !== null) return { ok: false, error, installment };

  // ensure_seller_is_eligible_to_publish_or_schedule_emails
  const scheduleParam = params.to_be_published_at;
  if ((present(scheduleParam) || present(params.publish)) && ip.send_emails !== undefined && ip.send_emails !== null && ip.send_emails !== false && !(await eligibleToSendEmails(seller))) {
    error = `You are not eligible to publish or schedule emails. Please ensure you have made at least $${MINIMUM_SALES_CENTS_VALUE / 100} in sales and received a payout.`;
    return { ok: false, error, installment };
  }

  // build_installment_if_needed
  if (installment === null) {
    installment = Installments.build(productOrVariant ? { link_id: Number(product!.id) } : { seller_id: Number(seller.id) });
    assign(installment, ip, attrs);
  } else if (installment.get("published_at") === null) {
    assign(installment, ip, attrs);
  } else {
    await assignPublished(installment, params, ip);
  }
  const record = installment;

  try {
    await transaction(
      async () => {
        // SaveContentUpsellsService#from_html
        const oldMessage = record.attributeWas("message");
        for (const html of [oldMessage, record.get("message")]) if (html !== null && /upsell-card/iu.test(html)) refuse("a message with an upsell card (SaveContentUpsellsService)");
        record.set("message", nokogiriRoundtrip(record.get("message")));
        await saveInstallmentRecord(record, ip, params, { seller, product, productOrVariant, attrs }, deps, (message) => (error = message));

        if (present(scheduleParam)) await scheduleInstallment(record, seller, scheduleParam, deps, (message) => (error = message), () => error);
        else if (present(params.publish)) await publishInstallment(record, deps, (message) => (error = message), () => error);
        else if (present(params.send_preview_email)) refuse("a preview email");

        return error === null;
      },
      { returningStatus: true },
    );
  } catch (caught) {
    if (caught instanceof NotPortedError || (caught instanceof Error && caught.name === "HandBackToRails")) throw caught;
    if (caught instanceof InstallmentInvalid || caught instanceof PreviewEmailError) error = caught.message;
    else {
      error ??= caught instanceof Error ? caught.message : String(caught);
      deps.notify(caught);
    }
  }
  return { ok: error === null, error, installment: record };
}

// published_installment_params
async function assignPublished(record: InstallmentRecord, params: RequestParams, ip: Permitted): Promise<void> {
  const allowed = ["name", "message", "shown_on_profile", "allow_comments"];
  if (!(await hasBeenBlasted(record.get("id")))) allowed.push("send_emails");
  let publishedAt: Date | null = null;
  const raw = (params.installment as Record<string, unknown>).published_at;
  if (present(raw)) {
    const { instant, day } = isoDate(typeof raw === "string" ? raw : refuse("a publish date that is not text"));
    const current = record.get("published_at")!;
    if (current.toISOString().slice(0, 10) !== day) {
      allowed.push("published_at");
      publishedAt = new Date(Math.floor(instant.getTime() / 1000) * 1000);
    }
  }
  assign(record, ip, allowed);
  if (publishedAt !== null) record.set("published_at", publishedAt);
}

async function saveInstallmentRecord(
  record: InstallmentRecord,
  ip: Permitted,
  params: RequestParams,
  context: { seller: User; product: Link | null; productOrVariant: boolean; attrs: readonly string[] },
  deps: SaveInstallmentDeps,
  fail: (message: string) => void,
): Promise<void> {
  const { seller, product, productOrVariant } = context;
  const wasPublished = record.get("published_at") !== null;
  if (!wasPublished) {
    record.set("installment_type", asString(ip.installment_type));
    record.set("base_variant_id", ip.installment_type === VARIANT_TYPE ? await findBaseVariantId(params.variant_external_id) : null);
    record.set("link_id", productOrVariant ? Number(product!.id) : null);
    record.set("seller_id", Number(seller.id));
    setAssociation(record, "seller", seller.id, seller);
    post(record).preload("seller", seller);
  }
  // `audience_type?` and the other recipient predicates read `attributes`, which materializes every attribute in column order.
  if (!wasPublished) record.materializeAll();
  if (!wasPublished && !record.untracked(() => addAndValidateFilters(record, ip, seller.timezone ?? "Pacific Time (US & Canada)"))) {
    fail(record.errors.fullMessages()[0]!);
    return;
  }
  if (!(await saveWithUniqueSlug(record, deps))) {
    fail(record.errors.fullMessages()[0]!);
    return;
  }
  await saveFiles(record, params);
  await updateProfilePostsSections(seller, record.get("id"), ip.shown_in_profile_sections, deps.now);
}

async function saveWithUniqueSlug(record: InstallmentRecord, deps: SaveInstallmentDeps): Promise<boolean> {
  try {
    return await Installments.save(record, { now: deps.now });
  } catch (error) {
    if (!isDatabaseDuplicate(error, "index_installments_on_slug")) throw error;
    record.set("slug", `${record.get("slug")}-${deps.hex4()}`);
    return Installments.save(record, { now: deps.now });
  }
}

// SaveFilesService.perform(installment, product_files_params) for a payload with no files and a post with none.
async function saveFiles(record: InstallmentRecord, params: RequestParams): Promise<void> {
  const files = (params.installment as Record<string, unknown>).files;
  if (files !== undefined && !(Array.isArray(files) && files.length === 0)) refuse("a post with files (SaveFilesService)");
  // save_files!: the alive files not in the payload are deleted, and the product's file types are reindexed.
  if ((await post(record).aliveProductFiles()).length > 0) refuse("a post with files (save_files!)");
  // is_downloadable?: the same alive files again
  await post(record).aliveProductFiles();
  const linkId = record.get("link_id");
  if (linkId !== null) await enqueueLinkIndexUpdate(linkId, ["filetypes"]);
}

// `installment.installment_rule` (has_one, with the inverse `installment` set), or `build_installment_rule`.
async function ruleOf(record: InstallmentRecord): Promise<ModelRecord<InstallmentRule>>;
async function ruleOf(record: InstallmentRecord, build: false): Promise<ModelRecord<InstallmentRule> | null>;
async function ruleOf(record: InstallmentRecord, build = true): Promise<ModelRecord<InstallmentRule> | null> {
  const row = await post(record).installmentRule();
  if (row === null && !build) return null;
  const rule = row === null ? InstallmentRules.build({ installment_id: record.get("id") }) : InstallmentRules.load(row);
  if (row !== null) rule.touch("installment_id");
  setAssociation(rule, "installment", record.get("id"), record.attributes as Installment);
  return rule;
}

async function scheduleInstallment(
  record: InstallmentRecord,
  seller: User,
  scheduleParam: unknown,
  deps: SaveInstallmentDeps,
  fail: (message: string) => void,
  currentError: () => string | null,
): Promise<void> {
  if (seller.confirmed_at === null) fail("You have to confirm your email address before you can do that.");
  if (currentError() !== null) return;
  const at = parseLocalTime(seller.timezone ?? "Pacific Time (US & Canada)", typeof scheduleParam === "string" ? scheduleParam : refuse("a publish time that is not text"));
  if (at === null) {
    fail("Please provide a valid date and time.");
    return;
  }
  const rule = await ruleOf(record);
  rule.set("deleted_at", null);
  rule.set("to_be_published_at", at);
  setFlag(record, "ready_to_publish", true);
  if ((await InstallmentRules.save(rule, { now: deps.now })) && (await Installments.save(record, { now: deps.now }))) {
    await performAsync("PublishScheduledPostJob", [record.get("id"), rule.get("version")], { at });
  } else {
    // Only the rule's errors are reported: a failed installment save leaves the error nil and the transaction commits.
    const message = rule.errors.fullMessages()[0];
    if (message !== undefined) fail(message);
  }
}

async function publishInstallment(record: InstallmentRecord, deps: SaveInstallmentDeps, fail: (message: string) => void, currentError: () => string | null): Promise<void> {
  if (currentError() !== null) return;
  try {
    await publishBang(record, { now: deps.now });
  } catch (caught) {
    if (!(caught instanceof RecordInvalid)) throw caught;
    fail(caught.errors.fullMessages()[0] ?? caught.message);
    return;
  }
  const rule = await ruleOf(record, false);
  if (rule !== null) await markRuleDeletedBang(rule, { now: deps.now });
  if (InstallmentFlags.isSet(record.get("flags"), "send_emails") && !(await hasBeenBlasted(record.get("id")))) {
    await createBlastAndEnqueue(post(record), deps.now(), deps.now);
  }
}
