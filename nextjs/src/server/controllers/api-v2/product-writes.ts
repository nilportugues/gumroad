// Api::V2::LinksController#create and #update (PUT and PATCH): the refusals that precede every write. The save itself (the Link callback
// chain, tags, rich content, files and their archives, publishing) is Rails': a request that passes every refusal below goes to Rails whole
// before anything is written, and Rack::Attack's count for it is taken back by the hand-back (rack-attack.ts counts once).
//
// #update writes in Node for the shapes the Link model port covers: name, is_adult, display_product_reviews and should_show_sales_count, and
// with them price (the one live USD buy price of a non-membership product), description (HTML Nokogiri leaves as it is, on a product that is
// not published) and tags (plain lowercase names), on a product whose rename needs no content moderation. Every other write is checked
// before the first statement, so a hand-back never follows one.
import { Prisma, type Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { existingS3KeyVariant, s3ObjectExists } from "../../infra/signed-urls.ts";
import { storageConfig } from "../../infra/storage.ts";
import { setJsonDataForAttr } from "../../models/concerns/json-data.ts";
import { nokogiriRoundtrip } from "../../models/html-fragment.ts";
import { createApiLink, type CreateSeller } from "../../models/link-create.ts";
import LINK_DATA from "../../models/link-data.generated.json" with { type: "json" };
import { assertPlainPublish, publishBang } from "../../models/link-publish.ts";
import { findLinkBang, LinkFlags, Links } from "../../models/link.ts";
import { MAX_PRICE_CENTS, planBuyPriceWrite, PRICE_TOO_LARGE, writeBuyPrice } from "../../models/price-writes.ts";
import { saveFilesForNewProduct, type NewFileParams } from "../../models/product-file-save.ts";
import { planTagChanges, saveTags } from "../../models/product-tags.ts";
import { RecordInvalid } from "../../models/runtime/errors.ts";
import { transaction } from "../../models/runtime/transaction.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { UserFlags } from "../../models/user.ts";
import { HandBackToRails, type Rendered } from "../application-controller.ts";
import type { Params } from "../rails-body.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  errorWithCreatingObject,
  json,
  loadProduct,
  present,
  registerApiV2,
  renderResponse,
  successWithObject,
  toSentence,
} from "./base.ts";
import { hasApplicableOfferCodes, offerCodePriceError } from "./offer-codes.ts";
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
function fileUrlError(files: Params[], ownerExternalId: string | null): string | null {
  if (files.some((file) => typeof file.url !== "string" || blankParam(file.url)))
    return "Each file must include a url string.";
  const prefix = `${storageConfig().s3BaseUrl}attachments/${ownerExternalId ?? ""}/`;
  if (
    files.some((file) => {
      const url = file.url as string;
      return !url.startsWith(prefix) || url.includes("..") || url.includes("%2F") || url.includes("%2f");
    })
  )
    return "File URLs must reference your own uploaded files. Use the presigned upload endpoint to upload files first.";
  return null;
}

// uploaded_file_storage_status and render_uploaded_file_error: every url must name an object in the bucket (or a Unicode variant of its key).
async function uploadedFileStorageError(files: Params[]): Promise<Rendered | null> {
  const base = storageConfig().s3BaseUrl;
  const exists = (key: string) => s3ObjectExists(key);
  try {
    for (const file of files) {
      const key = (file.url as string).slice(base.length);
      if ((await exists(key)) || (await existingS3KeyVariant(key, exists)) !== null) continue;
      return json(
        {
          success: false,
          message:
            "One or more file URLs do not point to an uploaded file. Finish each upload with POST /v2/files/complete and attach the file_url it returns.",
        },
        400,
      );
    }
  } catch {
    return json(
      { success: false, message: "File storage is temporarily unavailable. Retry attaching your uploaded files." },
      503,
    );
  }
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
    const error = fileUrlError(files as Params[], owner.external_id);
    if (error !== null) return refuse(error);
    const missing = await uploadedFileStorageError(files as Params[]);
    if (missing !== null) return missing;
  }

  return createDigitalProduct(input, nativeType, currency!);
}

// The params #create reads that the served shape does not write: each goes to Rails whole, before the first statement.
const UNSERVED_CREATE_KEYS = ["custom_permalink", "refund_period", "refund_fine_print", "rich_content"];

// ActiveModel::Type::Boolean#cast: nil for nil and "", false for the FALSE_VALUES, true for everything else.
function castBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return ![false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"].includes(value as never);
}

const MAX_POSITION = 2_147_483_647;

// `ActionController::Parameters#permit(files: [:id, :url, :display_name, :extension, :position, :stream_only, :description])`, then what SaveFilesService
// removes: the ids and the extension are never written. What the cast of a column would read differently from the JSON goes to Rails whole.
function permittedNewFiles(files: Params[]): NewFileParams[] {
  if (files.length === 0) throw new HandBackToRails("an empty files list");
  const urls = new Set<string>();
  return files.map((file) => {
    const url = file.url as string;
    // A repeated url reuses the file the first entry built.
    if (urls.has(url)) throw new HandBackToRails("the same file url twice");
    urls.add(url);
    if (present(file.id)) throw new HandBackToRails("a file entry with an id");
    if (present(file.extension) && file.extension === "URL") throw new HandBackToRails("a link file");
    const params: NewFileParams = { url };
    for (const key of ["url", "display_name", "extension", "id", "description", "position", "stream_only"]) {
      if (!has(file, key)) continue;
      const value = file[key];
      if (key === "url" || key === "extension" || key === "id") continue;
      if (key === "display_name" || key === "description") {
        if (value !== null && typeof value !== "string") throw new HandBackToRails(`a ${key} that is not text`);
        params[key] = value;
      } else if (key === "position") {
        if (
          value !== null &&
          !(typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_POSITION)
        )
          throw new HandBackToRails("a position that is not an integer");
        params.position = value;
      } else {
        if (typeof value !== "boolean") throw new HandBackToRails("a stream_only that is not a boolean");
        params.stream_only = value;
      }
    }
    return params;
  });
}

// create_as_draft?
const createAsDraft = (params: Params) =>
  castBoolean(params.draft) === true || (has(params, "published") && castBoolean(params.published) === false);

// #create for a digital product: a draft is built (name, description, price, taxonomy and custom_summary), saved, its description saved
// again as SaveContentUpsellsService returns it, tagged, and committed; then, outside the transaction, published unless a draft was asked for.
async function createDigitalProduct(input: ApiV2Input, nativeType: string, currency: string) {
  const { params, owner, request } = input;
  if (nativeType !== NATIVE_TYPE_DIGITAL) throw new HandBackToRails(`the creation of a ${nativeType} product`);
  if (UNSERVED_CREATE_KEYS.some((key) => has(params, key)))
    throw new HandBackToRails(
      "a creation with attributes beyond name, description, price, limits, taxonomy, tags and summary",
    );
  const viaCli = /^gumroad-cli\//iu.test(request.headers.get("user-agent") ?? "");
  if (currency !== "usd") throw new HandBackToRails("a product priced in a currency other than USD");
  if (has(params, "name") && typeof params.name !== "string") throw new HandBackToRails("a name that is not text");

  let priceCents: number | null = null;
  if (has(params, "price")) {
    const price = params.price;
    // `price_cents = nil` is the missing price: the model refuses it the same way.
    if (price === null) priceCents = null;
    else if (typeof price === "number" && Number.isSafeInteger(price) && price >= 0) priceCents = price;
    else if (typeof price === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(price)) priceCents = Number(price);
    else if (typeof price === "string" && DECIMAL_CENTS.test(price)) priceCents = Number(price.replace(/\..*$/u, ""));
    else throw new HandBackToRails("a price that is not a whole number of cents");
    // `price_cents=` raises LinkInvalid ahead of the first save.
    if (priceCents !== null && priceCents > MAX_PRICE_CENTS)
      return errorWithCreatingObject("product", { errors: [PRICE_TOO_LARGE] });
  }

  let description: string | null = null;
  if (has(params, "description")) {
    if (typeof params.description !== "string") throw new HandBackToRails("a description that is not text");
    if (/upsell-card/iu.test(params.description)) throw new HandBackToRails("a description with upsell cards");
    description = params.description;
    // The second save writes what Nokogiri returns, which equals the text for every fragment it accepts here.
    nokogiriRoundtrip(description);
  }
  if (has(params, "custom_summary") && present(params.custom_summary) && typeof params.custom_summary !== "string")
    throw new HandBackToRails("a custom_summary that is not text");
  const customSummary = present(params.custom_summary) ? (params.custom_summary as string) : null;
  if (
    customSummary !== null &&
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(customSummary)
  )
    throw new HandBackToRails("a custom_summary JSON.dump would refuse");

  let taxonomyId: bigint | null = null;
  if (present(params.taxonomy_id)) {
    const value = params.taxonomy_id;
    taxonomyId = typeof value === "string" ? rubyToI(value) : BigInt(value as number);
  }
  const maxPurchaseCount = has(params, "max_purchase_count")
    ? integerParam("max_purchase_count", params.max_purchase_count, { booleans: true, largePositive: true })
    : undefined;
  const suggestedPriceCents = has(params, "suggested_price_cents")
    ? integerParam("suggested_price_cents", params.suggested_price_cents)
    : undefined;
  const customizablePrice = has(params, "customizable_price")
    ? customizablePriceParam(params.customizable_price)
    : undefined;
  const tagWork = has(params, "tags")
    ? await planTagChanges(0n, params.tags as string[], { plainOnly: true })
    : undefined;
  const files = has(params, "files") ? permittedNewFiles(params.files as Params[]) : undefined;

  const draft = createAsDraft(params);
  let priceError: string | null = null;
  if (!draft) {
    // The product is not saved yet: its one buy price is what the create writes. A missing price fails the create before any publish.
    if (priceCents !== null)
      priceError = await offerCodePriceError(owner, { id: 0n, price_currency_type: currency } as Link, [priceCents]);
    await assertPlainPublish({ id: 0n, deleted_at: null, flags: 0n, draft: true } as Link, owner);
  }

  const scopes = (input.token.scopes ?? "").split(/\s+/u).filter(Boolean);
  const json = async (row: Link) => (await productsApiJson([row], { owner, scopes, slim: false }))[0]!;
  const seller: CreateSeller = {
    id: owner.id,
    flags: owner.flags,
    verified: owner.verified,
    confirmed_at: owner.confirmed_at,
    created_at: owner.created_at,
    user_risk_state: owner.user_risk_state,
    json_data: owner.json_data,
    isTeamMember: UserFlags.isSet(owner.flags, "is_team_member"),
  };
  let outcome: Awaited<ReturnType<typeof createApiLink>> | undefined;
  await transaction(async () => {
    outcome = await createApiLink(seller, {
      name: has(params, "name") ? (params.name as string) : null,
      description,
      priceCents,
      currency,
      taxonomyId,
      customSummary,
      maxPurchaseCount,
      customizablePrice,
      suggestedPriceCents,
      viaCli,
    });
    if (!outcome.created) return;
    const id = outcome.link.get("id");
    // The description is saved again as SaveContentUpsellsService returns it.
    if (description !== null) {
      await Links.updateBang(await findLinkBang(id), { description: nokogiriRoundtrip(description) });
    }
    if (tagWork !== undefined) await saveTags(id, tagWork);
    // SaveFilesService.perform, then `@product.save!`; the product has no rich content, variant or archive to rebuild.
    if (files !== undefined) await saveFilesForNewProduct(await findLinkBang(id), files);
  });
  if (!outcome!.created) return errorWithCreatingObject("product", { errors: outcome!.errors.fullMessages() });

  const id = outcome!.link.get("id");
  const additionalInfo: Record<string, unknown> = {};
  if (!draft) {
    const row = (await db.link.findUnique({ where: { id } }))!;
    const refused = priceError ?? (await publishBang(row, owner));
    if (refused !== null) additionalInfo.warning = `Saved as a draft: ${refused}`;
  }
  return successWithObject("product", await json((await db.link.findUnique({ where: { id } }))!), additionalInfo);
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
  "has_same_rich_content_for_all_variants",
  "refund_period",
  "refund_fine_print",
  "custom_html",
  "files",
  "rich_content",
  "cover_ids",
];
const UPDATE_FLAG_PARAMS = [
  "is_adult",
  "display_product_reviews",
  "should_show_sales_count",
  "quantity_enabled",
] as const;
// A text price with a fraction and no sign, exponent or underscore.
const DECIMAL_CENTS = /^(?:0|[1-9]\d{0,14})\.\d+$/u;
// The range of an integer column; ActiveModel raises RangeError beyond it.
const INT_RANGE = 2_147_483_647;
const MAX_CUSTOM_RECEIPT_LENGTH = 10_000;

// An integer attribute from a parameter, as ActiveModel::Type::Integer casts it: nil for null and for blank text, `to_i` for other text
// (leading digits, "_" between digits, 0 when there are none) and for a float (truncated). What the cast reads differently from here
// (true and false unless `booleans`, non-ASCII text, a value outside the column's range, which raises RangeError) goes to Rails.
function integerParam(
  key: string,
  value: unknown,
  { booleans = false, largePositive = false }: { booleans?: boolean; largePositive?: boolean } = {},
): number | null {
  if (value === null) return null;
  let cast: number;
  // ActiveModel casts true and false to 1 and 0.
  if (booleans && typeof value === "boolean") cast = value ? 1 : 0;
  else if (typeof value === "number" && Number.isFinite(value)) cast = Math.trunc(value) + 0;
  else if (typeof value === "string" && /^\p{ASCII}*$/u.test(value)) {
    if (/^[ \t\n\v\f\r]*$/u.test(value)) return null;
    const match = /^[ \t\n\v\f\r]*([-+]?\d+(?:_\d+)*)/u.exec(value);
    cast = match ? Number(match[1]!.replaceAll("_", "")) : 0;
  } else cast = Number.NaN;
  // A JSON number past the column is assigned as it is and refused by the model's range validation, before the write raises.
  if (largePositive && typeof value === "number" && cast > INT_RANGE && Number.isSafeInteger(cast)) return cast;
  if (!Number.isSafeInteger(cast) || Math.abs(cast) > INT_RANGE)
    throw new HandBackToRails(`a ${key} that is not a number or text, or is outside the integer range`);
  return cast;
}

// FlagShihTzu's TRUE_VALUES and ActiveModel's boolean cast differ on everything but a JSON boolean and these four spellings, which
// both read the same way (the recordings hold each).
const TEXT_BOOLEANS: Record<string, boolean> = { true: true, "1": true, false: false, "0": false };

function booleanParam(key: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && Object.hasOwn(TEXT_BOOLEANS, value)) return TEXT_BOOLEANS[value]!;
  throw new HandBackToRails(`a ${key} that is not true or false`);
}

function customizablePriceParam(value: unknown): boolean {
  return booleanParam("customizable_price", value);
}

// Link#published?
export const isPublishedProduct = (product: Link) =>
  product.deleted_at === null && product.purchase_disabled_at === null && !product.draft;

// #update with none of UNPORTED_UPDATE_KEYS: assign_attributes, save!, then the product JSON. A flag value other than a boolean or
// the text of one (see TEXT_BOOLEANS) goes to Rails.
async function updateSimpleAttributes(input: ApiV2Input, product: Link) {
  const { params, owner } = input;
  if (UNPORTED_UPDATE_KEYS.some((key) => has(params, key)))
    throw new HandBackToRails("an update of more than the simple attributes");
  if (has(params, "name") && typeof params.name !== "string") throw new HandBackToRails("a name that is not text");
  for (const key of UPDATE_FLAG_PARAMS) if (has(params, key)) booleanParam(key, params[key]);
  // content_moderation_check runs on the rename of a published product; check_offer_code_validity runs after every save.
  if (typeof params.name === "string" && params.name !== product.name && isPublishedProduct(product))
    throw new HandBackToRails("the rename of a published product");
  if (await hasApplicableOfferCodes(owner, product)) throw new HandBackToRails("offer codes whose validity is checked");
  const scopes = (input.token.scopes ?? "").split(/\s+/u).filter(Boolean);
  const json = async (row: Link) => (await productsApiJson([row], { owner, scopes, slim: false }))[0]!;
  // The response serializes the product: refuse what Node cannot before the write.
  await json(product);

  // Everything up to the transaction only reads.
  let priceCents: number | undefined;
  if (has(params, "price")) {
    // ActiveModel's integer cast reads "3.50" as 3, the digits before the point.
    const plan = await planBuyPriceWrite(
      product,
      typeof params.price === "string" && DECIMAL_CENTS.test(params.price)
        ? params.price.replace(/\..*$/u, "")
        : params.price,
    );
    // `price_cents=` raises LinkInvalid while the attributes are assigned, before anything is saved.
    if ("tooLarge" in plan) return refuse(PRICE_TOO_LARGE);
    priceCents = plan.cents;
  }
  const description = has(params, "description") ? plannedDescription(product, params.description) : undefined;
  const tagWork = has(params, "tags") ? await planTagChanges(product.id, params.tags as string[]) : undefined;

  const columns: Partial<Link> = {};
  if (has(params, "customizable_price")) {
    columns.customizable_price = booleanParam("customizable_price", params.customizable_price);
  }
  if (has(params, "suggested_price_cents"))
    columns.suggested_price_cents = integerParam("suggested_price_cents", params.suggested_price_cents, {
      largePositive: true,
    });
  if (has(params, "max_purchase_count"))
    columns.max_purchase_count = integerParam("max_purchase_count", params.max_purchase_count, { booleans: true });
  if (has(params, "taxonomy_id")) {
    const value = params.taxonomy_id;
    // validate_taxonomy_id_param let a blank value through: it clears the taxonomy.
    if (value === null || value === "") columns.taxonomy_id = null;
    else if (typeof value === "string") columns.taxonomy_id = rubyToI(value);
    else if (typeof value === "number") columns.taxonomy_id = BigInt(value);
    else throw new HandBackToRails("a taxonomy_id that is not text or a whole number");
  }
  if (has(params, "custom_receipt")) {
    const value = params.custom_receipt;
    if (value !== null && (typeof value !== "string" || value.length > MAX_CUSTOM_RECEIPT_LENGTH))
      throw new HandBackToRails("a custom_receipt that is not short text");
    columns.custom_receipt = value;
  }
  let customSummary: string | null | undefined;
  if (has(params, "custom_summary")) {
    const value = params.custom_summary;
    if (
      value !== null &&
      (typeof value !== "string" ||
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value))
    )
      throw new HandBackToRails("a custom_summary that is not text JSON.dump would write");
    customSummary = value;
  }

  let flags = product.flags;
  for (const key of UPDATE_FLAG_PARAMS)
    if (has(params, key)) flags = LinkFlags.set(flags, key, booleanParam(key, params[key]));
  const attributes: Partial<Link> = { flags, ...columns };
  if (typeof params.name === "string") attributes.name = params.name;
  if (description !== undefined) attributes.description = description;
  const record = Links.load(product);
  try {
    // The action's transaction: a refusal anywhere rolls back the price, the product and the tags together.
    await transaction(async () => {
      // `price_cents=` saves the Price row at once, while the attributes are assigned.
      if (priceCents !== undefined) await writeBuyPrice(product, priceCents);
      if (customSummary !== undefined) setJsonDataForAttr(record, "custom_summary", customSummary);
      await Links.updateBang(record, attributes);
      if (tagWork !== undefined) await saveTags(product.id, tagWork);
    });
  } catch (caught) {
    if (!(caught instanceof RecordInvalid)) throw caught;
    // The refused record is the product or, for tags, a Tag or ProductTagging: each renders its own messages.
    return renderResponse(false, {
      message: toSentence(caught.errors.fullMessages()) || "The product was unable to be modified.",
    });
  }
  return successWithObject("product", await json((await db.link.findUnique({ where: { id: product.id } }))!));
}

// SaveContentUpsellsService#from_html over the new and the old description: the new one comes back as Nokogiri serializes it, and the
// upsell cards of the old one are the upsells it retires. The moderation a published product's description change needs is Ruby's.
export function plannedDescription(product: Link, value: unknown): string {
  if (typeof value !== "string") throw new HandBackToRails("a description that is not text");
  if (product.description === null || /upsell-card/iu.test(product.description))
    throw new HandBackToRails("a description replacing one with upsell cards");
  const html = nokogiriRoundtrip(value);
  if (isPublishedProduct(product) && html !== product.description)
    throw new HandBackToRails("a description change of a published product");
  return html;
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
