// Api::V2::LinksController: #index, #show, #enable, #disable, #destroy and #update_sections. #create, #update, #comps, #preview_custom_html
// and #edit_custom_html stay in Rails: they upload files, search Elasticsearch or run the HTML sanitizer. #enable publishes in Node when the
// publication needs nothing outside the database (models/link-publish.ts); every other product goes to Rails whole.
import { Prisma, type Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { setJsonDataForAttr } from "../../models/concerns/json-data.ts";
import { assertPlainPublish, publishBang } from "../../models/link-publish.ts";
import { Links, productSections } from "../../models/link.ts";
import { RecordInvalid } from "../../models/runtime/errors.ts";
import { castRow, column, execute, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails, type Rendered } from "../application-controller.ts";
import { deleteProductBang } from "../products-mutations.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  error400,
  errorWithObject,
  loadProduct,
  PUBLIC_READ_SCOPES,
  registerApiV2,
  renderResponse,
  successWithObject,
  toSentence,
} from "./base.ts";
import { enableWithValidOfferCodes } from "./offer-codes.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";
import { productsApiJson } from "./product-json.ts";

// Api::V2::LinksController::RESULTS_PER_PAGE
const RESULTS_PER_PAGE = 10;
const LINKS = "links";

const productOf = (input: ApiV2Input): Link => input.state.product as Link;
const scopesOf = (input: ApiV2Input) => (input.token.scopes ?? "").split(/\s+/u).filter(Boolean);
const apiJson = async (input: ApiV2Input, product: Link, slim = false) =>
  (await productsApiJson([product], { owner: input.owner, scopes: scopesOf(input), slim }))[0]!;

// `GET /v2/products/comps` is drawn ahead of `/v2/products/:id`.
async function loadProductOrComps(input: ApiV2Input) {
  if (input.routeParams.id === "comps") throw new HandBackToRails("the comps collection route");
  return loadProduct("id")(input);
}

async function reloaded(product: Link): Promise<Link> {
  return (await db.link.findUnique({ where: { id: product.id } }))!;
}

async function index(input: ApiV2Input) {
  const { owner, request, params } = input;
  const conditions = [
    Prisma.sql`${column(LINKS, "user_id")} = ${owner.id}`,
    Prisma.sql`${column(LINKS, "deleted_at")} IS NULL`,
  ];
  const pageKey = params.page_key;
  if (typeof pageKey === "string" && pageKey !== "") {
    const decoded = decodePageKey(pageKey);
    if (decoded === null) return error400("Invalid page_key.");
    conditions.push(
      Prisma.sql`(${column(LINKS, "created_at")} < ${decoded.at} OR (${column(LINKS, "created_at")} = ${decoded.at} AND ${column(LINKS, "id")} < ${decoded.id}))`,
    );
  } else if (pageKey !== undefined && pageKey !== null && typeof pageKey !== "string") {
    throw new HandBackToRails("a page_key that is not a string");
  }
  const rows = await selectRows(
    Prisma.sql`SELECT ${table(LINKS)}.*, DATE_FORMAT(${column(LINKS, "created_at")}, ${USEC_FORMAT}) AS created_usec FROM ${table(LINKS)} WHERE ${Prisma.join(conditions, " AND ")} ORDER BY ${column(LINKS, "created_at")} DESC, ${column(LINKS, "id")} DESC LIMIT ${RESULTS_PER_PAGE + 1}`,
  );
  const page = rows.slice(0, RESULTS_PER_PAGE);
  const next =
    rows.length > RESULTS_PER_PAGE ? paginationInfo(request, page.at(-1) as { created_usec: string; id: bigint }) : {};
  const products = await productsApiJson(
    page.map((row) => castRow<Link>("Link", row)),
    { owner, scopes: scopesOf(input), slim: true },
  );
  return renderResponse(true, { products, ...next });
}

async function show(input: ApiV2Input) {
  return successWithObject("product", await apiJson(input, productOf(input)));
}

async function disable(input: ApiV2Input) {
  // The response serializes the product: refuse what Node cannot before the write.
  await apiJson(input, productOf(input));
  const record = Links.load(productOf(input));
  const now = new Date();
  // Link#unpublish!: `self.purchase_disabled_at ||= Time.current; save!`
  await Links.updateBang(
    record,
    { purchase_disabled_at: record.get("purchase_disabled_at") ?? now },
    { now: () => now },
  );
  return successWithObject("product", await apiJson(input, await reloaded(productOf(input))));
}

async function enable(input: ApiV2Input) {
  const product = productOf(input);
  // validate_product_price_against_all_offer_codes? checks every code that applies to the product.
  await enableWithValidOfferCodes(input.owner, product);
  await assertPlainPublish(product, input.owner);
  // The response serializes the product: refuse what Node cannot before the write.
  await apiJson(input, product);
  const refused = await publishBang(product, input.owner);
  if (refused !== null) return errorWithObject("product", { errors: [refused] });
  return successWithObject("product", await apiJson(input, await reloaded(product)));
}

async function destroy(input: ApiV2Input) {
  const product = productOf(input);
  await deleteProductBang(input.owner.id, Links.load(product));
  return successWithObject("product", null);
}

// Api::V2::ProductSectionsWriter
const ENTRY_MESSAGE = "sections must be an array of section ids or objects.";
const OWNERSHIP_MESSAGE = "One or more sections do not belong to this product.";
const MAX_HEADER_LENGTH = 255;
const CREATE_TYPES = ["featured_product", "products"];
const ENTRY_KEYS = [
  "featured_product",
  "shown_products",
  "default_product_sort",
  "show_filters",
  "add_new_products",
  "id",
  "type",
  "header",
];
const NON_NEGATIVE_INTEGER = /^\d+$/u;

const isJsonBody = (input: ApiV2Input) =>
  /^application\/json(\s*;|$)/iu.test(input.request.headers.get("content-type") ?? "");

// raw_sections_param: a JSON body is read raw (a `[null]` is not munged to `[]`), anything else from the params.
function sectionsParam(input: ApiV2Input): unknown {
  if (!isJsonBody(input)) return input.params.sections;
  try {
    const body: unknown = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).sections
      : null;
  } catch {
    return null;
  }
}

const decryptAll = (ids: string[]) => ids.map((id) => decrypt(id));

// Object#blank? for a JSON value.
const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === false ||
  (typeof value === "string" && !/[^\s]/u.test(value)) ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

type ParsedEntry = { id: number } | { error: string };

// ProductSectionsWriter#parse_entry. An entry that keeps a section as it is is served here; one that creates or
// changes a section writes, so it goes to Rails whole.
async function parseEntry(entry: unknown, product: Link, json: boolean): Promise<ParsedEntry> {
  if (!json && typeof entry !== "string") throw new HandBackToRails("a section entry of a form body that is not an id");
  const attributes = typeof entry === "string" ? { id: entry } : entry;
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes))
    return { error: ENTRY_MESSAGE };
  const fields = attributes as Record<string, unknown>;
  const unknownKey = Object.keys(fields).find((key) => !ENTRY_KEYS.includes(key));
  if (unknownKey !== undefined)
    return { error: `${unknownKey} is not a section field. Allowed: ${ENTRY_KEYS.join(", ")}.` };
  const { id, type, header } = fields;
  if ("header" in fields && typeof header !== "string") return { error: "header must be a string." };
  if (typeof header === "string" && [...header].length > MAX_HEADER_LENGTH)
    return { error: `header must be at most ${MAX_HEADER_LENGTH} characters.` };
  if (!isBlank(id) && !isBlank(type))
    return { error: "A section entry takes either id (an existing section) or type (a new one), not both." };
  if (isBlank(id) && isBlank(type)) return { error: "Each object in sections must have an id or a type." };

  if (isBlank(id)) {
    if (typeof type !== "string" || !CREATE_TYPES.includes(type))
      return { error: `type must be one of: ${CREATE_TYPES.join(", ")}.` };
    throw new HandBackToRails("a new profile section");
  }
  if (typeof id !== "string") return { error: ENTRY_MESSAGE };
  const decrypted = decrypt(id);
  if (decrypted === null) return { error: "One or more sections were not found." };
  const [section] = await selectRows<{ product_id: bigint | null }>(
    Prisma.sql`SELECT ${column("seller_profile_sections", "product_id")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "id")} = ${decrypted}`,
  );
  if (section === undefined || section.product_id === null || Number(section.product_id) !== Number(product.id))
    return { error: OWNERSHIP_MESSAGE };
  if (Object.keys(fields).some((key) => key !== "id" && key !== "type"))
    throw new HandBackToRails("a change to the contents of a profile section");
  return { id: decrypted };
}

export async function updateSections(input: ApiV2Input) {
  const product = productOf(input);
  await apiJson(input, product);
  const sections = sectionsParam(input);
  if (!Array.isArray(sections)) return renderResponse(false, { message: ENTRY_MESSAGE });
  const json = isJsonBody(input);
  const ids: number[] = [];
  for (const entry of sections) {
    const parsed = await parseEntry(entry, product, json);
    if ("error" in parsed) return renderResponse(false, { message: parsed.error });
    ids.push(parsed.id);
  }
  if (new Set(ids).size !== ids.length)
    return renderResponse(false, { message: "sections must not list the same section twice." });

  let knownIds: (number | null)[] | null = null;
  if ("known_section_ids" in input.params) {
    const known = input.params.known_section_ids;
    if (Array.isArray(known) && known.every((id) => typeof id === "string")) knownIds = decryptAll(known);
    if (knownIds === null || knownIds.some((id) => id === null))
      return renderResponse(false, { message: "known_section_ids must be an array of section ids." });
  }

  let mainSectionIndex: number | null = null;
  if ("main_section_index" in input.params) {
    const value = input.params.main_section_index;
    if (
      !((typeof value === "number" && Number.isInteger(value)) || typeof value === "string") ||
      !NON_NEGATIVE_INTEGER.test(String(value))
    )
      return renderResponse(false, { message: "main_section_index must be a non-negative integer." });
    mainSectionIndex = Math.min(Number(value), ids.length);
  }

  const record = Links.load(product);
  const outcome: { error: Rendered | null } = { error: null };
  try {
    await Links.withLock(record, async () => {
      // Checked under the product lock so a concurrent writer cannot add or remove a section between this check and the destroy below.
      const current = (
        await selectRows<{ id: bigint }>(
          Prisma.sql`SELECT ${column("seller_profile_sections", "id")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "product_id")} = ${product.id}`,
        )
      ).map((row) => Number(row.id));
      if (ids.some((id) => !current.includes(id))) {
        outcome.error = renderResponse(false, { message: "One or more sections do not belong to this product." });
        return;
      }
      if (knownIds && current.some((id) => !ids.includes(id) && !knownIds.includes(id))) {
        outcome.error = renderResponse(false, {
          message:
            "A section was added after this change was prepared. Read the product again and prepare a fresh sections list.",
          reason: "stale_known_sections",
        });
        return;
      }
      setJsonDataForAttr(record, "sections", ids);
      if (mainSectionIndex !== null) setJsonDataForAttr(record, "main_section_index", mainSectionIndex);
      await Links.saveBang(record);
      const kept = productSections(record);
      const keep =
        kept.length > 0
          ? Prisma.sql` AND ${column("seller_profile_sections", "id")} NOT IN (${Prisma.join(kept)})`
          : Prisma.empty;
      const stale = await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("seller_profile_sections", "id")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "product_id")} = ${product.id}${keep} ORDER BY ${column("seller_profile_sections", "id")}`,
      );
      // `seller_profile_sections.where.not(id: sections).destroy_all`: sections have no destroy callbacks.
      for (const { id } of stale)
        await execute(
          Prisma.sql`DELETE FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "id")} = ${id}`,
        );
    });
  } catch (caught) {
    if (!(caught instanceof RecordInvalid)) throw caught;
    return renderResponse(false, {
      message: toSentence(record.errors.fullMessages()) || "The product was unable to be modified.",
    });
  }
  if (outcome.error) return outcome.error;
  return successWithObject("product", await apiJson(input, await reloaded(product)));
}

registerApiV2(
  { method: "GET", pattern: "/v2/products", scopes: PUBLIC_READ_SCOPES, run: index },
  { method: "GET", pattern: "/v2/products/:id", scopes: PUBLIC_READ_SCOPES, before: loadProductOrComps, run: show },
  {
    method: "PUT",
    pattern: "/v2/products/:id/disable",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("id"),
    run: disable,
  },
  {
    method: "PUT",
    pattern: "/v2/products/:id/enable",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("id"),
    run: enable,
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("id"),
    run: destroy,
  },
  {
    method: "PUT",
    pattern: "/v2/products/:id/sections",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("id"),
    rawJsonBody: true,
    run: updateSections,
  },
);
