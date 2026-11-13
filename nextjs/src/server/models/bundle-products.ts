// app/models/bundle_product.rb and Bundle::UpdateProductsService (app/services/bundle/update_products_service.rb): the add, remove,
// re-add and reorder of a bundle's products.
//
// Handed back (NotPortedError) before the first write: a product id that is not text, one that matches no product, a quantity or
// position that is not an integer, a variant that is a SKU or has no category, a product with SKUs enabled, a bundle with an
// installment plan, and a search for sales that gives no total.
import { Prisma, type BundleProduct } from "@prisma/client";

import { decrypt, encrypt as externalId } from "../../lib/obfuscate-ids.ts";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { successfulSalesCount } from "./link-metrics.ts";
import { LinkFlags, Links, type LinkRecord } from "./link.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const FILE = "app/services/bundle/update_products_service.rb";
const NATIVE_TYPE_CALL = "call";
const INTEGER_TEXT = /^-?\d{1,9}$/u;

type Scalar = string | number | null | undefined;
export type BundleProductParams = {
  product_id?: Scalar;
  variant_id?: Scalar;
  quantity?: Scalar;
  position?: Scalar;
};

const handBack = (what: string): never => {
  throw new NotPortedError(what, FILE);
};

type ProductFacts = { id: bigint; user_id: bigint | null; flags: bigint; native_type: string | null };
type VariantFacts = { id: number; type: string | null; link_id: bigint | number | null };

const productFacts = async (id: bigint): Promise<ProductFacts | null> => {
  const [row] = await selectRows<ProductFacts>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "flags")}, ${column("links", "native_type")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
};

async function variantFacts(id: number): Promise<VariantFacts | null> {
  const [row] = await selectRows<VariantFacts>(
    Prisma.sql`SELECT ${column("base_variants", "id")}, ${column("base_variants", "type")}, ${column("variant_categories", "link_id")} FROM ${table("base_variants")} LEFT JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("base_variants", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `Link#has_multiple_variants?` without SKUs: `alive_variants.count > 1`.
async function hasMultipleVariants(productId: bigint): Promise<boolean> {
  const [row] = await selectRows<{ total: number | bigint }>(
    Prisma.sql`SELECT COUNT(*) AS total FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL`,
  );
  return Number(row?.total ?? 0) > 1;
}

const base = (message: string, record: { errors: { add(attribute: string, message: string): void } }) =>
  record.errors.add("base", message);

const validations: Callback<BundleProduct>[] = [
  {
    // `belongs_to :bundle`, `:product` (required)
    name: "belongs_to bundle and product",
    async run(record) {
      for (const [name, key] of [
        ["bundle", "bundle_id"],
        ["product", "product_id"],
      ] as const) {
        const [found] = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "id")} = ${record.get(key)} LIMIT 1`,
        );
        if (!found) record.errors.add(name, "required");
      }
    },
  },
  {
    name: "product_belongs_to_bundle_seller",
    async run(record) {
      const bundle = await productFacts(record.get("bundle_id"));
      const product = await productFacts(record.get("product_id"));
      if (bundle?.user_id == null || product?.user_id == null) handBack("a bundle or product without a seller");
      if (BigInt(bundle!.user_id!) !== BigInt(product!.user_id!))
        base("The product must belong to the bundle's seller", record);
    },
  },
  {
    name: "versioned_product_has_variant",
    async run(record) {
      if (record.get("variant_id") != null) return;
      if (await hasMultipleVariants(record.get("product_id")))
        base("Bundle product must have variant specified for versioned product", record);
    },
  },
  {
    name: "variant_belongs_to_product",
    async run(record) {
      if (record.get("variant_id") == null) return;
      const variant = await variantFacts(Number(record.get("variant_id")));
      if (variant?.link_id == null || BigInt(variant.link_id) !== BigInt(record.get("product_id")))
        base("The bundle product's variant must belong to its product", record);
    },
  },
  {
    name: "product_is_not_bundle",
    async run(record) {
      const product = await productFacts(record.get("product_id"));
      if (product && LinkFlags.isSet(product.flags, "is_bundle"))
        base("A bundle product cannot be added to a bundle", record);
    },
  },
  {
    name: "product_is_not_subscription",
    async run(record) {
      const product = await productFacts(record.get("product_id"));
      if (product && LinkFlags.isSet(product.flags, "is_recurring_billing"))
        base("A subscription product cannot be added to a bundle", record);
    },
  },
  {
    name: "product_is_not_call",
    async run(record) {
      const product = await productFacts(record.get("product_id"));
      if (product?.native_type === NATIVE_TYPE_CALL) base("A call product cannot be added to a bundle", record);
    },
  },
  {
    // `bundle.bundle_products.where(product_id:).where.not(id:)`: deleted rows count too.
    name: "is_not_duplicate",
    async run(record) {
      const id = record.newRecord ? null : record.get("id");
      const [found] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${record.get("bundle_id")} AND ${column("bundle_products", "product_id")} = ${record.get("product_id")} AND ${id === null ? Prisma.sql`${column("bundle_products", "id")} IS NOT NULL` : Prisma.sql`${column("bundle_products", "id")} != ${id}`} LIMIT 1`,
      );
      if (found) base("Product is already in bundle", record);
    },
  },
  // bundle_is_bundle_product: the caller only runs on a bundle. product_is_eligible_for_installment_plan: only with an installment plan.
];

const paperTrail = hasPaperTrail<BundleProduct>("BundleProduct", { itemType: "BundleProduct" });

export const BundleProducts = defineModel<BundleProduct>({
  rubyClass: "BundleProduct",
  prismaModel: "BundleProduct",
  delegate: (tx) => tx.bundleProduct as never,
  validations,
  afterCreate: paperTrail.afterCreate,
  afterUpdate: paperTrail.afterUpdate,
  afterTouch: paperTrail.afterTouch,
  beforeDestroy: paperTrail.beforeDestroy,
});

const integerOrNull = (value: Scalar, what: string): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) < 1e9) return value;
  if (typeof value === "string" && INTEGER_TEXT.test(value)) return Number(value);
  return handBack(`a ${what} that is not an integer`);
};

type Parsed = { product_id: string; variant_id: bigint | null; quantity: number; position: number | null };

// The list as the service reads it, refusing what Node cannot reproduce before any write.
export async function parseBundleProducts(entries: BundleProductParams[]): Promise<Parsed[]> {
  const parsed: Parsed[] = [];
  for (const entry of entries) {
    if (typeof entry.product_id !== "string") handBack("a product id that is not text");
    const quantity = integerOrNull(entry.quantity, "quantity");
    if (quantity === null) handBack("a missing quantity");
    let variant: bigint | null = null;
    const raw = entry.variant_id;
    if (raw !== null && raw !== undefined && raw !== "") {
      if (typeof raw !== "string") handBack("a variant id that is not text");
      const id = decrypt(raw as string);
      if (id !== null) {
        const facts = await variantFacts(Number(id));
        if (facts !== null) {
          if (facts.type !== "Variant" || facts.link_id === null)
            handBack("a variant that is a SKU or has no category");
          variant = BigInt(facts.id);
        }
      }
    }
    parsed.push({
      product_id: entry.product_id as string,
      variant_id: variant,
      quantity: quantity!,
      position: integerOrNull(entry.position, "position"),
    });
  }
  return parsed;
}

// `Link.find_by_external_id!`: Rails answers 404 for a product that is not there, so Node leaves that to it.
async function findProductId(external: string): Promise<bigint> {
  const id = decrypt(external);
  if (id !== null) {
    const facts = await productFacts(BigInt(id));
    if (facts) {
      if (LinkFlags.isSet(facts.flags, "skus_enabled")) handBack("a product with SKUs enabled");
      return facts.id;
    }
  }
  return handBack("a product that does not exist");
}

// Bundle::UpdateProductsService#perform. `bundle` is saved at the end, as `@bundle.save!`. Call inside a transaction.
export async function updateBundleProducts(
  bundle: LinkRecord,
  products: Parsed[],
  options: { now?: () => Date } = {},
): Promise<void> {
  const { now } = options;
  const pending = [...products];
  const bundleId = bundle.get("id");
  const existing = await selectRows<BundleProduct>(
    Prisma.sql`SELECT ${Prisma.raw("`bundle_products`.*")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${bundleId} ORDER BY ${column("bundle_products", "id")} ASC`,
  );

  // `has_outdated_purchases = true if successful_sales_count > 0`, asked of Elasticsearch only until the flag is set.
  const markOutdated = async () => {
    if (LinkFlags.isSet(bundle.get("flags"), "has_outdated_purchases")) return;
    const count = await successfulSalesCount({ id: bundleId } as Parameters<typeof successfulSalesCount>[0]);
    if (count === null) handBack("a sales count with no total");
    if (count! > 0) bundle.set("flags", LinkFlags.set(bundle.get("flags"), "has_outdated_purchases", true));
  };

  for (const row of existing) {
    const record = BundleProducts.load(castRow<BundleProduct>("BundleProduct", row as never));
    const product = await productFacts(record.get("product_id"));
    if (product === null) handBack("a bundle product whose product is gone");
    const index = pending.findIndex((entry) => entry.product_id === externalId(record.get("product_id")));
    if (index >= 0) {
      const entry = pending[index]!;
      await BundleProducts.updateBang(
        record,
        { variant_id: entry.variant_id, quantity: entry.quantity, deleted_at: null, position: entry.position },
        { now },
      );
      pending.splice(index, 1);
      await markOutdated();
    } else {
      record.set("deleted_at", (now ?? (() => new Date()))());
      await BundleProducts.save(record, { validate: false, now });
    }
  }

  if (pending.length > 0) await markOutdated();

  for (const entry of pending) {
    const productId = await findProductId(entry.product_id);
    await BundleProducts.createBang(
      {
        bundle_id: bundleId,
        product_id: productId,
        variant_id: entry.variant_id,
        quantity: entry.quantity,
        position: entry.position,
        deleted_at: null,
      },
      { now },
    );
  }

  await Links.saveBang(bundle, { now });
}
