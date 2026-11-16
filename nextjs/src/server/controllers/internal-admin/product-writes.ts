// Api::Internal::Admin::ProductsController#hold_sales, #release_sales_hold and #file_download. What the port cannot reproduce goes to
// Rails whole (a NotPortedError before the first write): holding a listing that is still on sale (Link#unpublish! runs the model's
// save callbacks) and the signed URL of a file stored on S3 (an expiring signature over a bucket check).
import { randomInt } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { LinkFlags } from "../../models/link.ts";
import { NotPortedError } from "../../models/user.ts";

import {
  type AdminRequest,
  failure,
  halted,
  isBlank,
  jsonRendered,
  recordAdminWrite,
  requirePerActorToken,
  timeJson,
} from "./base.ts";
import {
  PRODUCT_NOT_FOUND,
  SOURCE,
  activeSalesHold,
  idFromExternalId,
  serializeFile,
  serializeSalesHold,
  textParam,
} from "./products.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite } from "./user-writes.ts";

const EXTERNAL_ID_LENGTH = 21;
const EXTERNAL_ID_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SELLER_CHANGED_MESSAGE = "The product's seller changed since it was looked up";

type Tx = Prisma.TransactionClient;
type Seller = { id: bigint; email: string | null };
type Product = Prisma.LinkGetPayload<object>;

class SalesHoldSellerChanged extends Error {}

const auditTarget = (type: string, id: bigint) => ({ type, id, externalId: encrypt(id) });
const productTarget = (product: Product | null) => (product === null ? null : auditTarget("Link", product.id));

// find_seller_of_product_for_write_or_render
async function sellerOfProduct(
  admin: AdminRequest,
  product: Product | null,
): Promise<{ seller: Seller } | { refusal: ReturnType<typeof failure> }> {
  const found = await findUserForWrite(admin, false);
  if ("refusal" in found) return found;
  if (product === null) return { refusal: failure(PRODUCT_NOT_FOUND, 404) };
  if (product.user_id !== found.user.id) return { refusal: failure("Product does not belong to user", 422) };
  return { seller: found.user };
}

// lock_for_sales_hold!: the seller row before the product row, then a check that neither changed since the operator looked them up.
async function lockForSalesHold(tx: Tx, seller: Seller, productId: bigint): Promise<Product> {
  const [lockedSeller] = await tx.$queryRaw<
    { id: bigint; email: string | null }[]
  >`SELECT id, email FROM users WHERE id = ${seller.id} AND deleted_at IS NULL FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM links WHERE id = ${productId} FOR UPDATE`;
  const product = await tx.link.findUniqueOrThrow({ where: { id: productId } });
  if (lockedSeller !== undefined && lockedSeller.email === seller.email && product.user_id === lockedSeller.id)
    return product;
  throw new SalesHoldSellerChanged(SELLER_CHANGED_MESSAGE);
}

async function generateExternalId(tx: Tx): Promise<string> {
  for (;;) {
    const candidate = Array.from(
      { length: EXTERNAL_ID_LENGTH },
      () => EXTERNAL_ID_ALPHABET[randomInt(EXTERNAL_ID_ALPHABET.length)],
    ).join("");
    if ((await tx.productSalesHold.count({ where: { external_id: candidate } })) === 0) return candidate;
  }
}

// sales_hold_payload, over the rows as the writes left them.
async function salesHoldPayload(productId: bigint, holdId: bigint, status: string) {
  const product = await db.link.findUniqueOrThrow({ where: { id: productId } });
  const hold = await db.productSalesHold.findUniqueOrThrow({ where: { id: holdId } });
  const active = await activeSalesHold(productId);
  return jsonRendered({
    success: true,
    status,
    sales_hold: await serializeSalesHold(hold),
    product: {
      id: encrypt(product.id),
      alive: product.purchase_disabled_at === null && product.banned_at === null && product.deleted_at === null,
      published: product.deleted_at === null && product.purchase_disabled_at === null && product.draft !== true,
      draft: product.draft,
      purchase_disabled_at: timeJson(product.purchase_disabled_at),
      deleted_at: timeJson(product.deleted_at),
      banned_at: timeJson(product.banned_at),
      unpublished_by_admin: LinkFlags.isSet(product.flags, "is_unpublished_by_admin"),
      active_sales_hold_id: active?.external_id ?? null,
    },
  });
}

const findProduct = async (admin: AdminRequest): Promise<Product | null> => {
  const id = idFromExternalId(textParam(admin.params.id));
  return id === null ? null : db.link.findUnique({ where: { id } });
};

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/products/:id/hold_sales",
  run: async (admin) => {
    const unauthorized = requirePerActorToken(admin.admin);
    if (unauthorized !== null) return halted(unauthorized);
    const product = await findProduct(admin);
    return recordAdminWrite(
      admin,
      { action: "products.hold_sales", target: productTarget(product), wrapper: { key: "product" } },
      async () => {
        const found = await sellerOfProduct(admin, product);
        if ("refusal" in found) return found.refusal;
        try {
          const held = await db.$transaction(async (tx) => {
            const locked = await lockForSalesHold(tx, found.seller, product!.id);
            const existing = await tx.productSalesHold.findFirst({
              where: { product_id: locked.id, released_at: null },
              orderBy: { id: "asc" },
            });
            if (existing !== null) return { hold: existing, created: false };
            // unpublish! saves the product through its callbacks.
            if (locked.purchase_disabled_at === null)
              throw new NotPortedError("holding a listing that is still on sale", SOURCE);
            const now = new Date();
            const hold = await tx.productSalesHold.create({
              data: {
                external_id: await generateExternalId(tx),
                product_id: locked.id,
                held_by_id: admin.admin.actor.id,
                unpublished_listing: false,
                created_at: now,
                updated_at: now,
              },
            });
            return { hold, created: true };
          });
          return await salesHoldPayload(product!.id, held.hold.id, held.created ? "held" : "already_held");
        } catch (error) {
          if (error instanceof SalesHoldSellerChanged) return failure(error.message, 409);
          throw error;
        }
      },
    );
  },
});

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/products/:id/release_sales_hold",
  run: async (admin) => {
    const unauthorized = requirePerActorToken(admin.admin);
    if (unauthorized !== null) return halted(unauthorized);
    const product = await findProduct(admin);
    return recordAdminWrite(
      admin,
      { action: "products.release_sales_hold", target: productTarget(product), wrapper: { key: "product" } },
      async () => {
        if (isBlank(admin.params.hold_id)) return failure("hold_id is required", 400);
        const found = await sellerOfProduct(admin, product);
        if ("refusal" in found) return found.refusal;
        const hold = await db.productSalesHold.findFirst({
          where: { product_id: product!.id, external_id: textParam(admin.params.hold_id) },
        });
        if (hold === null) return failure("Sales hold not found", 404);
        try {
          const released = await db.$transaction(async (tx) => {
            await lockForSalesHold(tx, found.seller, product!.id);
            const [locked] = await tx.$queryRaw<
              { released_at: Date | null }[]
            >`SELECT released_at FROM product_sales_holds WHERE id = ${hold.id} FOR UPDATE`;
            if (locked === undefined || locked.released_at !== null) return false;
            await tx.productSalesHold.update({
              where: { id: hold.id },
              data: { released_at: new Date(), released_by_id: admin.admin.actor.id, updated_at: new Date() },
            });
            return true;
          });
          return await salesHoldPayload(product!.id, hold.id, released ? "released" : "already_released");
        } catch (error) {
          if (error instanceof SalesHoldSellerChanged) return failure(error.message, 409);
          throw error;
        }
      },
    );
  },
});

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/products/:id/files/:file_id/download_url",
  run: async (admin) => {
    const unauthorized = requirePerActorToken(admin.admin);
    if (unauthorized !== null) return halted(unauthorized);
    const product = await findProduct(admin);
    const fileId = idFromExternalId(textParam(admin.params.file_id));
    // Reviewed content is often the soft-deleted prior version of a file, so this does not filter to live files.
    const file =
      product === null || fileId === null
        ? null
        : await db.productFile.findFirst({ where: { id: fileId, link_id: product.id } });
    return recordAdminWrite(
      admin,
      { action: "products.file_download_url", target: file === null ? null : auditTarget("ProductFile", file.id) },
      async () => {
        if (product === null) return failure(PRODUCT_NOT_FOUND, 404);
        if (file === null) return failure("File not found", 404);
        if (file.filetype !== "link") throw new NotPortedError("the signed URL of a stored file", SOURCE);
        if (isBlank(file.url)) return failure("File is not available in storage", 404);
        const owner =
          product.user_id === null
            ? null
            : await db.user.findUnique({ where: { id: product.user_id }, select: { external_id: true } });
        return jsonRendered({
          success: true,
          signed_url: file.url,
          external_link: true,
          file: serializeFile(file, owner),
        });
      },
    );
  },
});
