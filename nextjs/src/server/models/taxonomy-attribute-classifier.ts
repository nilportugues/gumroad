// Port of app/services/discover/taxonomy_attribute_classifier.rb and fonts_attribute_classifier.rb, with the Link side they write
// through (Link#taxonomy, #inferred_taxonomy_attribute_values, #save_inferred_taxonomy_attribute_values) and TaxonomyAttribute#normalize_value.
// The classifier calls no model: it reads the product's own files, so there is nothing to stand in for.
// Golden: worker/jobs/__fixtures__/delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb).
import { Prisma, type Link } from "@prisma/client";

import { storageConfig } from "../infra/storage.ts";

import { jsonData, jsonGet, setJsonDataForAttr } from "./concerns/json-data.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { enqueueLinkIndexUpdate, Links, type LinkRecord } from "./link.ts";
import { s3Fields } from "./product-file.ts";
import type { Row } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, connection, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const TAXONOMY: BelongsTo = {
  name: "taxonomy",
  foreignKey: "taxonomy_id",
  targetTable: "taxonomies",
  targetModel: "Taxonomy",
};
const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };

// FontsAttributeClassifier::FORMAT_BY_EXTENSION
const FORMAT_BY_EXTENSION: Record<string, string> = { otf: "OTF", ttf: "TTF", woff2: "WOFF2" };
// FontsAttributeClassifier::VARIABLE_FONT_MARKERS, with \b as Ruby's Unicode word boundary.
const WORD = String.raw`[\p{L}\p{M}\p{N}\p{Pc}]`;
const VARIABLE_FONT_MARKERS = new RegExp(`(?<!${WORD})vf(?!${WORD})|variable`, "iu");
// TaxonomyAttributeClassifier::CLASSIFIERS, by taxonomy slug path.
const FONTS_PATH = "design/fonts";
const GUID_LENGTH = 32;
const INFERRED_KEY = "inferred_taxonomy_attribute_values";

// The record a product Row stands for: Ruby keeps one Link instance (and what it loaded) across the callbacks of its files.
const records = new WeakMap<object, LinkRecord>();
// The closure_tree ancestry path of a loaded taxonomy, memoized on that instance.
const ancestryPaths = new WeakMap<object, string[]>();
// The taxonomy's has_many :taxonomy_attributes target, loaded once per taxonomy instance.
const attributeSets = new WeakMap<object, Row[]>();

export function linkRecordFor(row: Row): LinkRecord {
  let record = records.get(row);
  if (!record) {
    record = Links.load(row as unknown as Link);
    records.set(row, record);
  }
  return record;
}

const ctxOf = async () => ({ tx: (await connection()) as never });

// Object#present? of a parsed JSON value.
function present(value: YamlValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value instanceof RubyHash) return value.entries.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return !isBlank(value);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// Link#inferred_taxonomy_attribute_values.present?
function hasInferredValues(link: LinkRecord): boolean {
  return present(jsonGet(jsonData(link), INFERRED_KEY));
}

async function taxonomyOf(link: LinkRecord): Promise<Row | null> {
  return loadBelongsTo(link, TAXONOMY, await ctxOf());
}

// closure_tree's `ancestry_path`: the slugs from the root down to the taxonomy.
async function ancestryPath(taxonomy: Row): Promise<string[]> {
  const memo = ancestryPaths.get(taxonomy);
  if (memo) return memo;
  const rows = await selectRows<{ slug: string }>(
    Prisma.sql`SELECT ${Prisma.raw("`taxonomies`.*")} FROM ${table("taxonomies")} INNER JOIN ${table("taxonomy_hierarchies")} ON ${column("taxonomies", "id")} = ${column("taxonomy_hierarchies", "ancestor_id")} WHERE ${column("taxonomy_hierarchies", "descendant_id")} = ${taxonomy.id} ORDER BY ${Prisma.raw("`taxonomy_hierarchies`.generations")} ASC`,
  );
  const path = rows.map((row) => row.slug).reverse();
  ancestryPaths.set(taxonomy, path);
  return path;
}

// Link#taxonomy_attributes_for_current_taxonomy: `taxonomy&.taxonomy_attributes`, the active ones in order.
async function taxonomyAttributes(link: LinkRecord): Promise<Row[]> {
  const taxonomy = await taxonomyOf(link);
  if (taxonomy === null) return [];
  const memo = attributeSets.get(taxonomy);
  if (memo) return memo;
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`taxonomy_attributes`.*")} FROM ${table("taxonomy_attributes")} WHERE ${column("taxonomy_attributes", "taxonomy_id")} = ${taxonomy.id} AND ${column("taxonomy_attributes", "active")} = TRUE ORDER BY ${column("taxonomy_attributes", "position")} ASC, ${column("taxonomy_attributes", "id")} ASC`,
  );
  attributeSets.set(taxonomy, rows);
  return rows;
}

// The classifier only ever submits text and `true`; any other value type is not ported.
type Submitted = string | true | undefined;

// TaxonomyAttribute#normalize_value for those submissions.
function normalizeValue(attribute: Row, value: Submitted): string | null {
  switch (attribute.value_type) {
    case "enum": {
      // normalized_options: Array(values).map(&:to_s)
      // The raw JSON column arrives as text.
      const options: unknown = typeof attribute.values === "string" ? JSON.parse(attribute.values) : attribute.values;
      if (options !== null && options !== undefined && !Array.isArray(options)) {
        throw new NotPortedError(
          "TaxonomyAttribute#normalized_options for a non-array",
          "app/models/taxonomy_attribute.rb",
        );
      }
      const text = value === undefined ? "" : String(value);
      return ((options ?? []) as unknown[]).map(String).includes(text) ? text : null;
    }
    case "boolean":
      // ActiveModel::Type::Boolean casts `true` and the text "true" alike.
      return value === undefined ? null : "true";
    case "number":
      // Float(true) is a TypeError and Float("OTF") an ArgumentError, both rescued to nil.
      if (typeof value === "string" && /^\s*[+-]?(\d|\.\d)/u.test(value)) {
        throw new NotPortedError(
          "TaxonomyAttribute#normalize_value for a numeric text",
          "app/models/taxonomy_attribute.rb",
        );
      }
      return null;
    default:
      return null;
  }
}

// Link#save_inferred_taxonomy_attribute_values
async function saveInferredValues(
  link: LinkRecord,
  submitted: Record<string, Submitted>,
  now: (() => Date) | undefined,
): Promise<boolean> {
  const values: [YamlValue, YamlValue][] = [];
  for (const attribute of await taxonomyAttributes(link)) {
    const value = normalizeValue(attribute, submitted[attribute.name as string]);
    // Every normalized value is a non-empty string, so Ruby's `value.present?` always holds.
    if (value !== null) values.push([attribute.name as string, value]);
  }
  setJsonDataForAttr(link, INFERRED_KEY, new RubyHash(values));
  const saved = await Links.save(link, { now });
  if (saved) await enqueueLinkIndexUpdate(link.get("id") as bigint, ["taxonomy_attribute_filters"], now);
  return saved;
}

// S3Retrievable#s3_display_name of a file of the product: the owner's external id is read only when the key is not guid-namespaced.
async function s3DisplayName(link: LinkRecord, url: string): Promise<string | null> {
  const base = storageConfig().s3BaseUrl;
  if (isBlank(url) || !url.startsWith(base)) return null;
  const namespaced = new RegExp(`^[^/]+/[^/]+/[A-Za-z0-9]{${GUID_LENGTH}}/original/`, "u").test(url.slice(base.length));
  let ownerExternalId: string | null = null;
  if (!namespaced) {
    const owner = await loadBelongsTo(link, USER, await ctxOf());
    ownerExternalId = (owner?.external_id as string | null | undefined) ?? null;
  }
  const fields = s3Fields(url, ownerExternalId)!;
  return fields.extension.length > 0 ? fields.filename.slice(0, -fields.extension.length) : fields.filename;
}

// FontsAttributeClassifier#inferred_values
async function fontsInferredValues(link: LinkRecord): Promise<Record<string, Submitted>> {
  const aliveFiles = Prisma.sql`${column("product_files", "link_id")} = ${link.get("id")} AND ${column("product_files", "deleted_at")} IS NULL`;
  const filetypes = await selectRows<{ filetype: string | null }>(
    Prisma.sql`SELECT ${column("product_files", "filetype")} FROM ${table("product_files")} WHERE ${aliveFiles}`,
  );
  const extensions = [...new Set(filetypes.flatMap((row) => (row.filetype === null ? [] : [row.filetype])))].filter(
    (type) => type in FORMAT_BY_EXTENSION,
  );
  if (extensions.length === 0) return {};

  const values: Record<string, Submitted> = {};
  if (extensions.length === 1) values.format = FORMAT_BY_EXTENSION[extensions[0]!];
  const files = await selectRows<{ display_name: string | null; filetype: string | null; url: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`product_files`.*")} FROM ${table("product_files")} WHERE ${aliveFiles}`,
  );
  for (const file of files) {
    // ProductFile#name_displayable
    const name =
      file.display_name !== null && !isBlank(file.display_name)
        ? file.display_name
        : file.filetype === "link"
          ? file.url
          : file.url === null
            ? null
            : await s3DisplayName(link, file.url);
    if (VARIABLE_FONT_MARKERS.test(name ?? "")) {
      values.variable_font = true;
      break;
    }
  }
  return values;
}

// Discover::TaxonomyAttributeClassifier.classify!(link)
export async function classifyTaxonomyAttributes(linkRow: Row, now: (() => Date) | undefined): Promise<boolean> {
  const link = linkRecordFor(linkRow);
  const taxonomy = await taxonomyOf(link);
  // classifier_for: no taxonomy has no classifier, and ancestry_path is read for any taxonomy.
  const path = taxonomy === null ? null : (await ancestryPath(taxonomy)).join("/");
  // A product off a classified taxonomy keeps no earlier classifier's values.
  if (path !== FONTS_PATH) return hasInferredValues(link) ? saveInferredValues(link, {}, now) : false;
  return saveInferredValues(link, await fontsInferredValues(link), now);
}
