// Port of Product::Tags#save_tags!, #tag! and #untag!, with the Tag and ProductTagging models they write, for what
// Api::V2::LinksController#update (`tags`) saves.
//
// `planTagChanges` runs before the first statement and throws NotPortedError for what the port does not follow: a name Tag's callbacks
// or validations would change or refuse (anything but plain lowercase ASCII), a repeated name, and names that MySQL's collation lookup
// resolves to a tag with another spelling or to the same tag as another name of the list. The writes then run in the order Rails takes
// the `tags` counter-cache rows: by tag id, removals first.
//
// Rails-recorded proof: spec/requests/api/v2/products_throttled_parity_spec.rb ("the tags"), replayed by api-v2-throttled.replay.
import { Prisma, type ProductTagging, type Tag } from "@prisma/client";

import { enqueueLinkIndexUpdate } from "./link.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesFormatOf, validatesLengthOf, validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const TAGS = "tags";
const PRODUCT_TAGGINGS = "product_taggings";
// Tag validates :name, length: { minimum: 2, maximum: 20 }
const MIN_TAG_LENGTH = 2;
const MAX_TAG_LENGTH = 20;
const TOO_SHORT = "A tag is too short. Please try again with a longer one, above 2 characters.";
const TOO_LONG = "A tag is too long. Please try again with a shorter one, under 20 characters.";
const INVALID_FORMAT = "A tag cannot start with hashes or contain commas.";
// A name `clean_name` and `String#downcase` leave alone, that the validations accept: lowercase ASCII with single inner spaces.
const PLAIN_TAG_NAME = /^[a-z0-9](?:[a-z0-9_-]| (?! ))*[a-z0-9]$/u;

const notPorted = (what: string): never => {
  throw new NotPortedError(what, "app/models/concerns/product/tags.rb");
};

export const Tags = defineModel<Tag>({
  rubyClass: "Tag",
  prismaModel: "Tag",
  delegate: (tx) => tx.tag as never,
  beforeValidation: [
    {
      // Tag#clean_name; plain names (see PLAIN_TAG_NAME) come out unchanged.
      name: "clean_name",
      if: (tag) => tag.attributeChanged("name"),
      run(tag) {
        const name = tag.get("name");
        if (name != null) tag.set("name", name.toLowerCase().trim().replace(/\s+/gu, " "));
      },
    },
  ],
  validations: [
    validatesPresenceOf<Tag>(["name"]),
    {
      // validates :name, uniqueness: { case_sensitive: true }
      name: "validates_uniqueness_of name",
      async run(tag) {
        const name = tag.get("name");
        if (name == null) return;
        const rows = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table(TAGS)} WHERE ${column(TAGS, "name")} = BINARY ${name} LIMIT 1`,
        );
        if (rows.length > 0) tag.errors.add("name", "taken", { value: name });
      },
    },
    validatesLengthOf<Tag>(["name"], {
      minimum: MIN_TAG_LENGTH,
      too_short: TOO_SHORT,
      maximum: MAX_TAG_LENGTH,
      too_long: TOO_LONG,
    }),
    validatesFormatOf<Tag>(["name"], { with: /^[^#,][^,]+$/u, message: INVALID_FORMAT }),
  ],
});

type TaggingWrite = ModelRecord<ProductTagging>;

// counter_cache: :taggings_count adjusts the tag's row with a relative update, which leaves updated_at alone.
async function adjustTaggingsCount(tagId: number | null, by: 1 | -1): Promise<void> {
  if (tagId == null) return;
  await execute(
    Prisma.sql`UPDATE ${table(TAGS)} SET ${column(TAGS, "taggings_count")} = COALESCE(${column(TAGS, "taggings_count")}, 0) ${Prisma.raw(by === 1 ? "+" : "-")} 1 WHERE ${column(TAGS, "id")} = ${tagId}`,
  );
}

const updateProductSearchIndex = {
  // after_commit :update_product_search_index!
  name: "update_product_search_index!",
  async run(tagging: TaggingWrite, ctx: { now?: () => Date }) {
    const productId = tagging.get("product_id");
    // The product is read back with `product&.`: a deleted one has nothing to index.
    if (productId == null) return;
    const [product] = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1`,
    );
    if (product) await enqueueLinkIndexUpdate(productId, ["tags"], ctx.now);
  },
};

export const ProductTaggings = defineModel<ProductTagging>({
  rubyClass: "ProductTagging",
  prismaModel: "ProductTagging",
  delegate: (tx) => tx.productTagging as never,
  validations: [
    {
      // validates_uniqueness_of :product_id, scope: :tag_id
      name: "validates_uniqueness_of product_id",
      async run(tagging) {
        const [productId, tagId] = [tagging.get("product_id"), tagging.get("tag_id")];
        const eq = (name: string, value: unknown) =>
          value == null
            ? Prisma.sql`${column(PRODUCT_TAGGINGS, name)} IS NULL`
            : Prisma.sql`${column(PRODUCT_TAGGINGS, name)} = ${value}`;
        const rows = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table(PRODUCT_TAGGINGS)} WHERE ${eq("product_id", productId)} AND ${eq("tag_id", tagId)} LIMIT 1`,
        );
        if (rows.length > 0) tagging.errors.add("product_id", "taken", { value: productId });
      },
    },
  ],
  afterCreate: [{ name: "increment_counter_cache", run: (tagging) => adjustTaggingsCount(tagging.get("tag_id"), 1) }],
  afterDestroy: [{ name: "decrement_counter_cache", run: (tagging) => adjustTaggingsCount(tagging.get("tag_id"), -1) }],
  afterCommit: [updateProductSearchIndex],
});

// Tag.find_by(name:): MySQL compares under the column's collation (utf8mb4_unicode_ci) and picks no row in particular among several.
async function tagsNamed(name: string): Promise<{ id: number; name: string | null }[]> {
  return selectRows<{ id: number; name: string | null }>(
    Prisma.sql`SELECT ${column(TAGS, "id")}, ${column(TAGS, "name")} FROM ${table(TAGS)} WHERE ${column(TAGS, "name")} = ${name}`,
  );
}

type Work = { name: string; action: "remove" | "add"; tagId: number | null };

// The tags of the product by tag id (`product_taggings` is ordered by it): `tags.pluck(:name)`.
async function currentTagNames(productId: number | bigint): Promise<string[]> {
  const rows = await selectRows<{ name: string | null }>(
    Prisma.sql`SELECT ${column(TAGS, "name")} FROM ${table(TAGS)} INNER JOIN ${table(PRODUCT_TAGGINGS)} ON ${column(TAGS, "id")} = ${column(PRODUCT_TAGGINGS, "tag_id")} WHERE ${column(PRODUCT_TAGGINGS, "product_id")} = ${productId} ORDER BY ${column(PRODUCT_TAGGINGS, "tag_id")} ASC`,
  );
  return rows.map((row) => row.name ?? "");
}

// The work `save_tags!` does for `tagList`, in the order it does it. Reads only; throws NotPortedError for a list outside the shapes above.
export async function planTagChanges(productId: number | bigint, tagList: string[]): Promise<Work[]> {
  if (new Set(tagList).size !== tagList.length) notPorted("a tag list that repeats a name");
  const current = await currentTagNames(productId);
  const toRemove = current.filter((name) => !tagList.includes(name));
  const toAdd = tagList.filter((name) => !current.includes(name));
  for (const name of [...toRemove, ...toAdd])
    if (!PLAIN_TAG_NAME.test(name) || name.length < MIN_TAG_LENGTH || name.length > MAX_TAG_LENGTH)
      notPorted("a tag name that is not plain lowercase ASCII of 2 to 20 characters");

  const work: Work[] = [
    ...toRemove.map((name) => ({ name, action: "remove" as const, tagId: null })),
    ...toAdd.map((name) => ({ name, action: "add" as const, tagId: null })),
  ];
  const seen = new Set<number>();
  for (const item of work) {
    const rows = await tagsNamed(item.name);
    if (rows.length > 1) notPorted("a tag name that more than one tag row matches");
    const [row] = rows;
    if (row !== undefined) {
      if (row.name !== item.name) notPorted("a tag name that matches a tag spelled differently");
      if (seen.has(row.id)) notPorted("two tag names that resolve to the same tag");
      seen.add(row.id);
      item.tagId = row.id;
    }
  }
  return work.sort(
    (a, b) =>
      (a.tagId ?? Number.POSITIVE_INFINITY) - (b.tagId ?? Number.POSITIVE_INFINITY) ||
      (a.action === "remove" ? 0 : 1) - (b.action === "remove" ? 0 : 1) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

// Product::Tags#untag!: `has_tag?` reads the product's tags again, then the product's taggings of the tag are destroyed one by one.
async function untag(productId: number | bigint, name: string): Promise<void> {
  if (!(await currentTagNames(productId)).includes(name)) return;
  const [tag] = await tagsNamed(name);
  if (tag === undefined) return;
  const taggings = await selectRows<ProductTagging>(
    Prisma.sql`SELECT ${Prisma.raw("`product_taggings`.*")} FROM ${table(PRODUCT_TAGGINGS)} WHERE ${column(PRODUCT_TAGGINGS, "product_id")} = ${productId} AND ${column(PRODUCT_TAGGINGS, "tag_id")} = ${tag.id} ORDER BY ${column(PRODUCT_TAGGINGS, "tag_id")} ASC`,
  );
  for (const row of taggings)
    await ProductTaggings.destroyBang(ProductTaggings.load(castRow<ProductTagging>("ProductTagging", row)));
}

// Product::Tags#tag!: the tag is found or created, then the tagging saved (which counts it).
async function tag(productId: number | bigint, name: string): Promise<void> {
  const [row] = await tagsNamed(name);
  let tagId = row?.id;
  if (tagId === undefined) {
    const created = await Tags.saveBang(Tags.build({ name }));
    tagId = created.get("id");
  }
  await ProductTaggings.saveBang(ProductTaggings.build({ product_id: Number(productId), tag_id: tagId }));
}

// Product::Tags#save_tags!, over a plan.
export async function saveTags(productId: number | bigint, work: Work[]): Promise<void> {
  for (const item of work) {
    if (item.action === "remove") await untag(productId, item.name);
    else await tag(productId, item.name);
  }
}
