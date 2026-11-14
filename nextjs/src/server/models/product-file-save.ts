// WithProductFiles#save_files! for a product that has no file yet, as Api::V2::LinksController#create calls it through SaveFilesService:
// each entry becomes a ProductFile (url first, then the permitted attributes), flagged when the seller already has the same url on another
// product, then `content_updated_at` moves and the product's file types are reindexed. Reusing, updating or deleting the files of an existing
// product are not ported.
// Golden: __fixtures__/product-file-create.golden.json (scripts/golden/product-file-create.rb).
import { Prisma, type Link } from "@prisma/client";

import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { enqueueLinkIndexUpdate, Links, type LinkRecord } from "./link.ts";
import { ProductFiles, type ProductFileRecord } from "./product-file-writes.ts";
import { ProductFileFlags } from "./product-file.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

// The attributes SaveFilesService hands `update!` once the keys the client cannot write are gone.
export type NewFileParams = {
  url: string;
  display_name?: string | null;
  description?: string | null;
  position?: number | null;
  stream_only?: boolean | null;
};

const WRITABLE = ["display_name", "description", "position", "stream_only"] as const;

// `link.user.alive_product_files_excluding_product.where("product_files.url = ? AND product_files.link_id != ?", url, link.id).any?`
async function linkedToExistingFile(sellerId: bigint, linkId: bigint, url: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("product_files")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_files", "link_id")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("product_files", "deleted_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("product_files", "url")} = ${url} AND ${column("product_files", "link_id")} != ${linkId} GROUP BY ${column("product_files", "url")} LIMIT 1`,
  );
  return rows.length > 0;
}

// WithProductFiles.associate_dropbox_file_and_product_file: a pending Dropbox upload of the same url would be attached to the file.
async function hasPendingDropboxFile(sellerId: bigint, url: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("dropbox_files")} WHERE ${column("dropbox_files", "user_id")} = ${sellerId} AND ${column("dropbox_files", "s3_url")} = ${url} AND ${column("dropbox_files", "product_file_id")} IS NULL LIMIT 1`,
  );
  return rows.length > 0;
}

// Must run inside the request's transaction. `link` is the product as it was just saved.
export async function saveFilesForNewProduct(
  link: LinkRecord,
  files: NewFileParams[],
  now?: () => Date,
): Promise<ProductFileRecord[]> {
  const linkRow = link.attributes as Link;
  const sellerId = linkRow.user_id!;
  const created: ProductFileRecord[] = [];
  for (const params of files) {
    if (await hasPendingDropboxFile(sellerId, params.url))
      throw new NotPortedError("A file with a pending Dropbox upload", "app/modules/with_product_files.rb");
    const flagged = await linkedToExistingFile(sellerId, linkRow.id, params.url);
    const record = ProductFiles.build({ link_id: linkRow.id, url: params.url });
    setAssociation(record, "link", linkRow.id, linkRow);
    for (const key of WRITABLE) {
      if (!(key in params)) continue;
      if (key === "stream_only")
        record.set("flags", ProductFileFlags.set(record.get("flags"), "stream_only", params.stream_only === true));
      else record.set(key, params[key] as never);
    }
    if (flagged) record.set("flags", ProductFileFlags.set(record.get("flags"), "is_linked_to_existing_file", true));
    await ProductFiles.saveBang(record, { now });
    created.push(record);
  }
  if (created.length > 0) link.set("content_updated_at", (now ?? (() => new Date()))());
  await afterCommitEverywhere(() => enqueueLinkIndexUpdate(linkRow.id, ["filetypes"], now));
  // `@product.save!`
  await Links.saveBang(link, { now });
  return created;
}
