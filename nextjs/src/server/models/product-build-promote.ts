// Port of ProductBuild#promote! (app/models/product_build.rb) for a product whose content is one set of pages: the product row lock, the
// superseded build's file marked deleted, the new zip as a ProductFile, the build made live, and the zip embedded on the first page while the
// old one leaves every page (swap_file_embed). The order is the `timeline` of the Rails recordings in
// spec/requests/api/v2/product_builds_writes_parity_spec.rb; product-build-promote.test.ts pins it.
//
// Handed back, as NotPortedError before the first write (the plan is read under the lock, ahead of every write): a product with no pages, a build that is already
// live (the restore branch), a product with versions (per-version pages and the `base_variants_product_files` joins), a page with a folder
// or a product with a folder archive (generate_product_files_archives! would build or drop zip archives), a description the port does not
// read, a description Rails would reject, a stored build that no longer validates, and a version page owner.
import { randomUUID } from "node:crypto";

import type { Link, ProductBuild, ProductFile, RichContent } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { storageConfig } from "../infra/storage.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { ProductBuilds, productBuildValid, truncateName } from "./product-build.ts";
import { ProductFileDeletable, ProductFiles } from "./product-file-writes.ts";
import {
  fileEmbedNode,
  FILE_EMBED_GROUP_NODE_TYPE,
  isPlainDescription,
  rejectFileEmbeds,
  sameDescription,
  type DescriptionNode,
} from "./rich-content-description.ts";
import { descriptionWriteRefusal, RichContents } from "./rich-content-writes.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const FILE = "app/models/product_build.rb";
const SUPERSEDED = "superseded";
const LIVE = "live";

type Page = { row: RichContent; description: DescriptionNode[] };
type PageWrite = { page: Page; description: DescriptionNode[]; addsEmbed: boolean };
type Plan = {
  build: ProductBuild;
  previous: ProductBuild | null;
  replacedFile: ProductFile | null;
  pageWrites: PageWrite[];
};

const handBack = (what: string): never => {
  throw new NotPortedError(what, FILE);
};

const rowsOf = <T>(model: Prisma.ModelName, rows: Record<string, unknown>[]) =>
  rows.map((row) => castRow<T & Record<string, unknown>>(model, row));

const hasAliveVariants = async (productId: bigint) =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' LIMIT 1`,
    )
  ).length > 0;

const hasFolderArchive = async (productId: bigint) =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("product_files_archives")} WHERE ${column("product_files_archives", "link_id")} = ${productId} AND ${column("product_files_archives", "folder_id")} IS NOT NULL AND ${column("product_files_archives", "deleted_at")} IS NULL LIMIT 1`,
    )
  ).length > 0;

// The pages of the product (`alive_rich_contents`, in the order the database returns them) whose description the port reads.
async function alivePages(productId: bigint): Promise<Page[]> {
  const rows = rowsOf<RichContent>(
    "RichContent",
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`rich_contents`.*")} FROM ${table("rich_contents")} WHERE ${column("rich_contents", "entity_id")} = ${productId} AND ${column("rich_contents", "entity_type")} = 'Link' AND ${column("rich_contents", "deleted_at")} IS NULL`,
    ),
  );
  return rows.map((row) => {
    const description = row.description as unknown;
    if (!isPlainDescription(description)) return handBack("a page whose description the port does not read");
    // generate_folder_archives! builds a zip for a folder of files, and drops one whose folder is gone.
    if (description.some((node) => node.type === FILE_EMBED_GROUP_NODE_TYPE))
      return handBack("a page with a folder of files");
    return { row, description };
  });
}

// Which pages `swap_file_embed(old_file, new_file)` rewrites, and to what. The new file's embed is appended to the first page (smallest
// position, the first met on a tie) unless the page already embeds it, which a file created a moment ago never does.
async function planPages(product: Link, pages: Page[], replaced: ProductFile | null): Promise<PageWrite[]> {
  if (pages.length === 0) return [];
  const first = pages.reduce((best, page) => (page.row.position < best.row.position ? page : best));
  const writes: PageWrite[] = [];
  for (const page of pages) {
    const kept = replaced ? rejectFileEmbeds(page.description, [Number(replaced.id)]) : page.description;
    const addsEmbed = page === first;
    // The appended node embeds the file this request creates, which belongs to the product: only what stays is checked.
    if (!addsEmbed && sameDescription(kept, page.description)) continue;
    const refusal = await descriptionWriteRefusal(product, kept);
    if (refusal !== null) return handBack(`a page with ${refusal}`);
    writes.push({ page, description: kept, addsEmbed });
  }
  return writes;
}

async function planPromotion(product: Link, buildId: bigint): Promise<Plan> {
  const [buildRow] = rowsOf<ProductBuild>(
    "ProductBuild",
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_builds`.*")} FROM ${table("product_builds")} WHERE ${column("product_builds", "id")} = ${buildId} LIMIT 1`,
    ),
  );
  if (buildRow === undefined) return handBack("a build that is gone");
  if (buildRow.status === LIVE) return handBack("the promotion of the live build");
  if (!productBuildValid(buildRow)) return handBack("a build that no longer validates");
  if (await hasAliveVariants(product.id)) return handBack("a product with versions");
  if (await hasFolderArchive(product.id)) return handBack("a product with a folder archive");

  const [previous = null] = rowsOf<ProductBuild>(
    "ProductBuild",
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_builds`.*")} FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${product.id} AND ${column("product_builds", "status")} = ${LIVE} AND ${column("product_builds", "id")} != ${buildRow.id} ORDER BY ${column("product_builds", "number")} ASC LIMIT 1`,
    ),
  );
  if (previous !== null && !productBuildValid(previous)) return handBack("a build that no longer validates");

  let replacedFile: ProductFile | null = null;
  if (previous?.product_file_id != null) {
    [replacedFile = null] = rowsOf<ProductFile>(
      "ProductFile",
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`product_files`.*")} FROM ${table("product_files")} WHERE ${column("product_files", "id")} = ${previous.product_file_id} LIMIT 1`,
      ),
    );
  }
  const pages = await alivePages(product.id);
  // swap_file_embed creates a page holding the zip for a product that has none.
  if (pages.length === 0) return handBack("a product with no pages");
  return { build: buildRow, previous, replacedFile, pageWrites: await planPages(product, pages, replacedFile) };
}

// ProductBuild#promote! for a build that is not live. Returns the build as it was left, or throws NotPortedError before writing anything.
export async function promoteBuildBang(
  productId: bigint,
  buildId: bigint,
  options: { now?: () => Date; uuid?: () => string } = {},
): Promise<ProductBuild> {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  await transaction(async () => {
    // product.with_lock: lock!, which reloads the row under FOR UPDATE.
    const [product] = rowsOf<Link>(
      "Link",
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1 FOR UPDATE`,
      ),
    );
    if (product === undefined) return handBack("a product that is gone");
    const plan = await planPromotion(product, buildId);

    if (plan.previous !== null) {
      if (plan.replacedFile !== null)
        await ProductFileDeletable.markDeletedBang(ProductFiles.load(plan.replacedFile), { now });
      const previous = ProductBuilds.load(plan.previous);
      await ProductBuilds.updateBang(previous, { status: SUPERSEDED }, { now });
    }

    const file = ProductFiles.build({
      link_id: product.id,
      url: `${storageConfig().s3BaseUrl}${plan.build.storage_key}`,
      display_name: `${truncateName(product.name ?? "")} build ${plan.build.number}.zip`,
    });
    setAssociation(file, "link", product.id, product);
    await ProductFiles.saveBang(file, { now });
    const fileId = file.get("id");

    const build = ProductBuilds.load(plan.build);
    await ProductBuilds.updateBang(build, { status: LIVE, promoted_at: now(), product_file_id: fileId }, { now });

    for (const { page, description, addsEmbed } of plan.pageWrites) {
      const nodes = addsEmbed ? [...description, fileEmbedNode(encrypt(fileId), uuid())] : description;
      const record = RichContents.load(page.row);
      setAssociation(record, "entity", record.get("entity_id"), product);
      await RichContents.updateBang(record, { description: nodes as never }, { now });
    }
    // generate_product_files_archives! has no folder to build or drop here: the plan refused both.
  });
  const [after] = rowsOf<ProductBuild>(
    "ProductBuild",
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_builds`.*")} FROM ${table("product_builds")} WHERE ${column("product_builds", "id")} = ${buildId} LIMIT 1`,
    ),
  );
  // Queued outside the lock: the job reads this row and must not run before it commits.
  await performAsync("ProductBuildUnpackJob", [Number(buildId)]);
  return after!;
}
