// Api::V2::LinksController#create and #update (PUT and PATCH): the refusals that precede every write. The save itself (the Link callback
// chain, tags, rich content, files and their archives, publishing) is Rails': a request that passes every refusal below goes to Rails whole
// before anything is written, and Rack::Attack's count for it is taken back by the hand-back (rack-attack.ts counts once).
//
// #update writes in Node for the one shape the Link model port covers: name, is_adult, display_product_reviews and should_show_sales_count
// on a product whose rename needs no content moderation. Every other write is checked before the first statement, so a hand-back never follows one.
import { Prisma, type Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { storageConfig } from "../../infra/storage.ts";
import LINK_DATA from "../../models/link-data.generated.json" with { type: "json" };
import { LinkFlags, Links } from "../../models/link.ts";
import { RecordInvalid } from "../../models/runtime/errors.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails, type Rendered } from "../application-controller.ts";
import type { Params } from "../rails-body.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  loadProduct,
  present,
  registerApiV2,
  renderResponse,
  successWithObject,
  toSentence,
} from "./base.ts";
import { hasApplicableOfferCodes } from "./offer-codes.ts";
import { productsApiJson } from "./product-json.ts";
import { accountLevelRefundPolicyEnabled } from "./refund-policies.ts";
import { blankParam, isHash, rubyToI, rubyToS } from "./ruby-params.ts";

const CURRENCY_CHOICES = new Set<string>(Object.keys(LINK_DATA.currencies));
// Link::LEGACY_TYPES and Link::NATIVE_TYPE_PHYSICAL
const UNSUPPORTED_NATIVE_TYPES = ["podcast", "newsletter", "audiobook", "physical"];
const NATIVE_TYPE_DIGITAL = "digital";
const NATIVE_TYPE_MEMBERSHIP = "membership";
// enum :subscription_duration
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"];
// Page::MAX_CUSTOM_HTML_LENGTH
export const MAX_CUSTOM_HTML_LENGTH = 500_000;
// Api::V2::RefundPoliciesController::REFUND_PERIOD_ALLOWED_VALUES, preceded by "inherit"
const PRODUCT_REFUND_PERIOD_ALLOWED_VALUES = ["inherit", "none", "7", "14", "30", "183"];
// Api::V2::LinksController::UNSUPPORTED_UPLOAD_FIELDS
const UNSUPPORTED_UPLOAD_FIELDS = ["file", "preview", "thumbnail"] as const;
const SAFE_INTEGER_BOUND = BigInt(Number.MAX_SAFE_INTEGER);
const RUBY_STRIP = /^[\t-\r ]+|[\t-\r ]+$/gu;
const WHITESPACE_OR_NON_ASCII = /[^\x20-\x7e\t-\r]/u;

const has = (params: Params, key: string) => Object.hasOwn(params, key);
const refuse = (message: string) => renderResponse(false, { message });

// Api::V2::BaseController#custom_html_length_error
export function customHtmlLengthError(params: Params): string | null {
  const value = params.custom_html;
  return typeof value === "string" && [...value].length > MAX_CUSTOM_HTML_LENGTH
    ? `custom_html is too long (maximum is ${MAX_CUSTOM_HTML_LENGTH} characters).`
    : null;
}

// legacy_upload_present?: a blank value is no upload, a hash or list holds one if any of its values does, anything else is one.
function legacyUploadPresent(value: unknown): boolean {
  if (blankParam(value)) return false;
  if (isHash(value)) return Object.values(value).some(legacyUploadPresent);
  if (Array.isArray(value)) return value.some(legacyUploadPresent);
  return true;
}

const PRESIGN_FLOW =
  "Upload files with the presign flow (POST /v2/files/presign, upload parts to the returned S3 URLs, then POST /v2/files/complete), then attach them by including the returned URLs in files[][url].";

function uploadFieldGuidance(field: (typeof UNSUPPORTED_UPLOAD_FIELDS)[number], creating: boolean): string {
  switch (field) {
    case "file":
      return creating
        ? PRESIGN_FLOW
        : `${PRESIGN_FLOW} Note: files is a full replacement — to keep an existing file, include an entry with its id; files missing from the array are removed.`;
    case "preview":
      return creating
        ? "Covers can only be added after the product is created. Create the product first, then POST to /v2/products/:id/covers with a url or signed_blob_id."
        : "Use POST /v2/products/:id/covers with a url or signed_blob_id to add a cover.";
    case "thumbnail":
      return creating
        ? "Thumbnails can only be set after the product is created. Create the product first, then POST to /v2/products/:id/thumbnail with a signed_blob_id."
        : "Use POST /v2/products/:id/thumbnail with a signed_blob_id to set the thumbnail.";
  }
}

// before_action :reject_unsupported_upload_fields
const rejectUnsupportedUploadFields = (creating: boolean) =>
  function before({ params }: ApiV2Input): Rendered | undefined {
    const field = UNSUPPORTED_UPLOAD_FIELDS.find((key) => legacyUploadPresent(params[key]));
    if (field === undefined) return undefined;
    const verbPath = creating ? "POST /v2/products" : "PUT /v2/products/:id";
    return refuse(`'${field}' is not an accepted parameter on ${verbPath}. ${uploadFieldGuidance(field, creating)}`);
  };

// validate_taxonomy_id_param. `Taxonomy.exists?(value)` casts the value with String#to_i; one outside the safe range raises RangeError in Rails.
async function validateTaxonomyIdParam(
  params: Params,
  invalidMessage = "Invalid taxonomy_id.",
): Promise<Rendered | undefined> {
  const value = params.taxonomy_id;
  if (blankParam(value)) return undefined;
  if (isHash(value) || Array.isArray(value)) return refuse("taxonomy_id must be a scalar value.");
  let id: bigint;
  if (typeof value === "string") id = rubyToI(value);
  else if (typeof value === "number" && Number.isSafeInteger(value)) id = BigInt(value);
  else throw new HandBackToRails("a taxonomy_id that is not text or a whole number");
  if (id > SAFE_INTEGER_BOUND || id < -SAFE_INTEGER_BOUND)
    throw new HandBackToRails("a taxonomy_id outside the safe range");
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("taxonomies", "id")} FROM ${table("taxonomies")} WHERE ${column("taxonomies", "id")} = ${id} LIMIT 1`,
  );
  return row === undefined ? refuse(invalidMessage) : undefined;
}

// before_action :resolve_category_param. Looking a category up by its path is Discover::TaxonomyPresenter's.
async function resolveCategoryParam({ params }: ApiV2Input): Promise<Rendered | undefined> {
  if (has(params, "category")) {
    const category = params.category;
    if (isHash(category) || Array.isArray(category)) return refuse("category must be a scalar value.");
    if (present(category)) {
      if (present(params.taxonomy_id)) return refuse("Specify either category or taxonomy_id, not both.");
      throw new HandBackToRails("a category to look up in the taxonomy presenter");
    }
  }
  return validateTaxonomyIdParam(params);
}

// normalize_price_currency_type: `currency.to_s.strip.downcase.presence`. Whatever Ruby's strip and downcase treat beyond ASCII goes to Rails.
export function normalizePriceCurrencyType(value: unknown): string | null {
  const text = rubyToS(value);
  if (WHITESPACE_OR_NON_ASCII.test(text.replace(/[\t-\r ]/gu, "")))
    throw new HandBackToRails("a currency that is not plain ASCII");
  const normalized = text.replace(RUBY_STRIP, "").toLowerCase();
  return normalized === "" ? null : normalized;
}

export const supportedCurrency = (currency: string | null) => currency !== null && CURRENCY_CHOICES.has(currency);

const isTextList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

// The shared shape of `rich_content` in #create and #update.
function richContentError(value: unknown): string | null {
  if (!Array.isArray(value) || value.some((page) => !isHash(page)))
    return "rich_content must be an array of content page objects.";
  for (const page of value as Params[]) {
    const description = page.description;
    if (blankParam(description)) continue;
    if (!isHash(description) && !Array.isArray(description))
      return "Each rich_content page description must be a JSON object or array.";
    let nodes: unknown = description;
    if (isHash(description)) {
      if (present(description.content) && !Array.isArray(description.content))
        return "rich_content description content must be an array.";
      nodes = description.content;
    }
    if (Array.isArray(nodes) && nodes.some((node) => !isHash(node)))
      return "Each rich_content content node must be a JSON object.";
  }
  return null;
}

// validate_product_refund_policy_params. `productRefundPolicyEnabled` is the product's flag on #update and false on #create (no @product).
async function refundPolicyError(input: ApiV2Input, productRefundPolicyEnabled: boolean): Promise<string | null> {
  const { params, owner } = input;
  if (!has(params, "refund_period") && !has(params, "refund_fine_print")) return null;
  if (await accountLevelRefundPolicyEnabled(owner))
    return "Product-level refund policies are not available for this account; the account-level refund policy applies to all products. Use PUT /v2/refund_policy instead.";
  if (has(params, "refund_period")) {
    const period = params.refund_period;
    if (typeof period !== "string" || !PRODUCT_REFUND_PERIOD_ALLOWED_VALUES.includes(period))
      return `refund_period must be one of: ${PRODUCT_REFUND_PERIOD_ALLOWED_VALUES.join(", ")}.`;
    if (period === "inherit" && present(params.refund_fine_print))
      return "refund_fine_print cannot be set when refund_period is 'inherit'; the account-level policy's fine print applies.";
  }
  if (has(params, "refund_fine_print")) {
    const finePrint = params.refund_fine_print;
    if (finePrint !== null && typeof finePrint !== "string") return "refund_fine_print must be a string.";
    if (!has(params, "refund_period") && !productRefundPolicyEnabled)
      return "refund_fine_print requires refund_period, or an existing product-level refund policy.";
  }
  return null;
}

// validate_file_urls. A url must be text, and under the seller's own upload prefix with no path trick.
function fileUrlError(files: Params[], ownerId: bigint): string | null {
  if (files.some((file) => typeof file.url !== "string" || blankParam(file.url)))
    return "Each file must include a url string.";
  const prefix = `${storageConfig().s3BaseUrl}attachments/${encrypt(ownerId)}/`;
  if (
    files.some((file) => {
      const url = file.url as string;
      return !url.startsWith(prefix) || url.includes("..") || url.includes("%2F") || url.includes("%2f");
    })
  )
    return "File URLs must reference your own uploaded files. Use the presigned upload endpoint to upload files first.";
  return null;
}

async function hasMultipleRecurrences(productId: bigint): Promise<boolean> {
  const [row] = await selectRows<{ recurrences: bigint }>(
    Prisma.sql`SELECT COUNT(DISTINCT ${column("prices", "recurrence")}) AS recurrences FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${productId} AND ${column("prices", "deleted_at")} IS NULL AND ${column("prices", "flags")} & 1 = 0`,
  );
  return Number(row?.recurrences ?? 0) > 1;
}

async function create(input: ApiV2Input) {
  const { params, owner } = input;
  let nativeType = NATIVE_TYPE_DIGITAL;
  if (has(params, "native_type") && present(params.native_type)) {
    if (typeof params.native_type !== "string") throw new HandBackToRails("a native_type that is not text");
    nativeType = params.native_type;
  }
  if (UNSUPPORTED_NATIVE_TYPES.includes(nativeType))
    return refuse(`The product type '${nativeType}' is not supported for creation.`);

  if (has(params, "subscription_duration") && present(params.subscription_duration)) {
    const duration = params.subscription_duration;
    if (typeof duration !== "string") throw new HandBackToRails("a subscription_duration that is not text");
    if (!SUBSCRIPTION_DURATIONS.includes(duration))
      return refuse(`Invalid subscription duration '${duration}'. Valid values: ${SUBSCRIPTION_DURATIONS.join(", ")}.`);
    if (nativeType !== NATIVE_TYPE_MEMBERSHIP)
      return refuse("subscription_duration is only valid for membership products.");
  }

  // Only an absent key falls back to the seller's default; a supplied but blank currency is an invalid value.
  const supplied = has(params, "price_currency_type");
  const currency = supplied ? normalizePriceCurrencyType(params.price_currency_type) : owner.currency_type;
  if (!supportedCurrency(currency))
    return refuse(
      `'${supplied ? rubyToS(params.price_currency_type) : (currency ?? "")}' is not a supported currency.`,
    );

  if (has(params, "tags") && !isTextList(params.tags)) return refuse("tags must be an array of strings.");

  const refund = await refundPolicyError(input, false);
  if (refund !== null) return refuse(refund);

  if (has(params, "rich_content")) {
    const error = richContentError(params.rich_content);
    if (error !== null) return refuse(error);
  }

  if (has(params, "files")) {
    const files = params.files;
    if (!Array.isArray(files) || files.some((file) => !isHash(file)))
      return refuse("files must be an array of file objects.");
    const error = fileUrlError(files as Params[], owner.id);
    if (error !== null) return refuse(error);
    // uploaded_file_storage_status asks S3 whether each object exists.
    throw new HandBackToRails("files whose objects are checked in S3");
  }

  throw new HandBackToRails("the creation of a product");
}

async function update(input: ApiV2Input) {
  const { params, owner } = input;
  const product = input.state.product as Link;
  const tiered = LinkFlags.isSet(product.flags, "is_tiered_membership");
  if (tiered && has(params, "price"))
    return refuse(
      "Price cannot be updated for tiered membership products. Use the variant endpoints to manage tier pricing.",
    );

  const currency = normalizePriceCurrencyType(params.price_currency_type);
  if (has(params, "price_currency_type") && !supportedCurrency(currency))
    return refuse(`'${rubyToS(params.price_currency_type)}' is not a supported currency.`);

  // Changing currency re-denominates every alive Price row, which a tier or several payment options cannot carry.
  if (has(params, "price_currency_type") && currency !== product.price_currency_type) {
    if (tiered)
      return refuse(
        "Currency cannot be updated for tiered membership products. Use the variant endpoints to manage tier pricing.",
      );
    if (LinkFlags.isSet(product.flags, "is_recurring_billing") && (await hasMultipleRecurrences(product.id)))
      return refuse(
        "Currency cannot be updated for products with multiple payment options. Update them in the product editor.",
      );
  }

  if (has(params, "custom_html") && !(await isFeatureEnabled("custom_html_pages", userActor(owner.id))))
    return refuse("You do not have access to custom HTML pages.");
  if (has(params, "custom_html") && params.custom_html !== null && typeof params.custom_html !== "string")
    return refuse("custom_html must be a string.");
  const tooLong = customHtmlLengthError(params);
  if (tooLong !== null) return refuse(tooLong);

  const refund = await refundPolicyError(input, LinkFlags.isSet(product.flags, "product_refund_policy_enabled"));
  if (refund !== null) return refuse(refund);

  if (has(params, "tags") && !isTextList(params.tags)) return refuse("tags must be an array of strings.");

  if (has(params, "rich_content")) {
    const error = richContentError(params.rich_content);
    if (error !== null) return refuse(error);
  }

  if (has(params, "files")) {
    const files = params.files;
    if (!Array.isArray(files) || files.some((file) => !isHash(file)))
      return refuse("files must be an array of file objects.");
    if ((files as Params[]).some((file) => has(file, "modified")))
      return refuse("'modified' is not an accepted parameter on files[]; it is an internal save-path flag.");
    // The per-file url checks depend on the product's existing files, and the S3 check on the bucket.
    throw new HandBackToRails("files whose urls are matched against the product's files and checked in S3");
  }

  if (has(params, "cover_ids") && !isTextList(params.cover_ids))
    return refuse("cover_ids must be an array of strings.");

  return updateSimpleAttributes(input, product);
}

// The attributes #update reads that the simple path does not write.
const UNPORTED_UPDATE_KEYS = [
  "custom_permalink",
  "price_currency_type",
  "price",
  "customizable_price",
  "suggested_price_cents",
  "max_purchase_count",
  "quantity_enabled",
  "taxonomy_id",
  "custom_receipt",
  "has_same_rich_content_for_all_variants",
  "description",
  "custom_summary",
  "refund_period",
  "refund_fine_print",
  "custom_html",
  "files",
  "rich_content",
  "tags",
  "cover_ids",
];
const UPDATE_FLAG_PARAMS = ["is_adult", "display_product_reviews", "should_show_sales_count"] as const;

// Link#published?
const isPublishedProduct = (product: Link) =>
  product.deleted_at === null && product.purchase_disabled_at === null && !product.draft;

// #update with none of UNPORTED_UPDATE_KEYS: assign_attributes, save!, then the product JSON. A flag value other than true or false
// goes to Rails (FlagShihTzu's TRUE_VALUES and ActiveModel's casts differ from each other).
async function updateSimpleAttributes(input: ApiV2Input, product: Link) {
  const { params, owner } = input;
  if (UNPORTED_UPDATE_KEYS.some((key) => has(params, key)))
    throw new HandBackToRails("an update of more than the simple attributes");
  if (has(params, "name") && typeof params.name !== "string") throw new HandBackToRails("a name that is not text");
  for (const key of UPDATE_FLAG_PARAMS)
    if (has(params, key) && typeof params[key] !== "boolean")
      throw new HandBackToRails(`a ${key} that is not true or false`);
  // content_moderation_check runs on the rename of a published product; check_offer_code_validity runs after every save.
  if (typeof params.name === "string" && params.name !== product.name && isPublishedProduct(product))
    throw new HandBackToRails("the rename of a published product");
  if (await hasApplicableOfferCodes(owner, product)) throw new HandBackToRails("offer codes whose validity is checked");
  const scopes = (input.token.scopes ?? "").split(/\s+/u).filter(Boolean);
  const json = async (row: Link) => (await productsApiJson([row], { owner, scopes, slim: false }))[0]!;
  // The response serializes the product: refuse what Node cannot before the write.
  await json(product);

  let flags = product.flags;
  for (const key of UPDATE_FLAG_PARAMS) if (has(params, key)) flags = LinkFlags.set(flags, key, params[key] as boolean);
  const attributes: Partial<Link> = { flags };
  if (typeof params.name === "string") attributes.name = params.name;
  const record = Links.load(product);
  try {
    await Links.updateBang(record, attributes);
  } catch (caught) {
    if (!(caught instanceof RecordInvalid)) throw caught;
    return renderResponse(false, {
      message: toSentence(record.errors.fullMessages()) || "The product was unable to be modified.",
    });
  }
  return successWithObject("product", await json((await db.link.findUnique({ where: { id: product.id } }))!));
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products",
    scopes: EDIT_PRODUCTS_SCOPES,
    async before(input) {
      return rejectUnsupportedUploadFields(true)(input) ?? resolveCategoryParam(input);
    },
    run: create,
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/v2/products/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    async before(input: ApiV2Input) {
      return (
        rejectUnsupportedUploadFields(false)(input) ?? (await resolveCategoryParam(input)) ?? loadProduct("id")(input)
      );
    },
    run: update,
  })),
);
