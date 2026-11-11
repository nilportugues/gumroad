// Api::Internal::Admin::UrlRedirectsController: the buyer's delivery state (#show) and the per-buyer download grant (#grant_download,
// #revoke_download). The files come from the delivery port (aliveProductFiles), which hands the request back to Rails whole for
// the shapes it does not prove (installments, preorders, variants, rich content, stamped PDFs) before anything is written.
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { isExternalLink, isStreamOnly } from "../../models/product-file.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { NotPortedError } from "../../models/user.ts";
import { RoutingError } from "../application-controller.ts";
import { loadRedirect, type Loaded } from "../url-redirects/access.ts";
import { aliveProductFiles, isFileDownloadable, type DeliveryFile } from "../url-redirects/files.ts";

import {
  type AdminRequest,
  failure,
  halted,
  isBlank,
  jsonRendered,
  paramToS,
  recordAdminWrite,
  requirePerActorToken,
} from "./base.ts";
import { idFromExternalId } from "./products.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/controllers/api/internal/admin/url_redirects_controller.rb";
const WRAPPER = { key: "url_redirect", model: "UrlRedirect" };
const NOT_FOUND = "Url redirect not found";

async function findUrlRedirect(admin: AdminRequest): Promise<Loaded | null> {
  try {
    return await loadRedirect(paramToS(admin.params.id, SOURCE));
  } catch (error) {
    if (error instanceof RoutingError) return null;
    throw error;
  }
}

// ProductFile#name_displayable
function displayName({ file, s3 }: DeliveryFile): string | null {
  if (!isBlank(file.display_name)) return file.display_name;
  if (isExternalLink(file)) return file.url;
  if (s3 === null) return null;
  return s3.extension.length > 0 ? s3.filename.slice(0, -s3.extension.length) : s3.filename;
}

async function serialize(loaded: Loaded) {
  const { redirect, purchase, product } = loaded;
  const files = await aliveProductFiles(loaded);
  const grants = await db.productFileDownloadGrant.findMany({
    where: { url_redirect_id: redirect.id },
    select: { product_file_id: true },
  });
  const granted = new Set(grants.map((grant) => grant.product_file_id));
  return {
    id: encrypt(redirect.id),
    token: redirect.token,
    purchase_id: purchase === null ? null : encrypt(purchase.id),
    buyer_email: purchase?.email ?? null,
    product_id: product === null ? null : encrypt(product.id),
    product_name: product?.name ?? null,
    files: await Promise.all(
      files.map(async (delivery) => ({
        id: encrypt(delivery.file.id),
        name: displayName(delivery),
        downloads_disabled: isStreamOnly(delivery.file),
        download_granted: granted.has(delivery.file.id),
        downloadable: await isFileDownloadable(loaded, delivery),
      })),
    ),
  };
}

const notFound = (message: string) => failure(message, 404);
const refused = (message: string) => failure(message, 422);
const target = (loaded: Loaded) => ({
  type: "UrlRedirect",
  id: loaded.redirect.id,
  externalId: encrypt(loaded.redirect.id),
});

// url_redirect.product_file: an alive file of the redirect, by its external id.
async function findFile(loaded: Loaded, rawId: unknown): Promise<DeliveryFile | null> {
  const externalId = paramToS(rawId, SOURCE);
  if (externalId === "") return null;
  const id = idFromExternalId(externalId);
  if (id === null) return null;
  return (await aliveProductFiles(loaded)).find(({ file }) => file.id === id) ?? null;
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/url_redirects/:id",
    run: async (admin) => {
      const loaded = await findUrlRedirect(admin);
      if (loaded === null) return notFound(NOT_FOUND);
      return jsonRendered({ success: true, url_redirect: await serialize(loaded) });
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/url_redirects/:id/grant_download",
    run: async (admin) => {
      const unauthorized = requirePerActorToken(admin.admin);
      if (unauthorized !== null) return halted(unauthorized);
      const loaded = await findUrlRedirect(admin);
      if (loaded === null) return notFound(NOT_FOUND);
      if (loaded.purchase === null) return refused("Downloads can only be granted on a purchase's url redirect");
      if (UrlRedirectFlags.isSet(loaded.redirect.flags, "is_rental"))
        return refused("Rental purchases cannot be granted downloads");
      const delivery = await findFile(loaded, admin.params.product_file_id);
      if (delivery === null) return notFound("File not found");
      if (!isStreamOnly(delivery.file)) return refused("Downloads are already enabled for this file");

      return recordAdminWrite(
        admin,
        { action: "url_redirects.grant_download", target: target(loaded), wrapper: WRAPPER },
        async () => {
          const key = { url_redirect_id: loaded.redirect.id, product_file_id: delivery.file.id };
          if ((await db.productFileDownloadGrant.count({ where: key })) === 0) {
            const now = new Date();
            try {
              await db.productFileDownloadGrant.create({ data: { ...key, created_at: now, updated_at: now } });
            } catch (error) {
              // A grant that landed since the check: Rails' find_or_create_by! would have found it.
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
                throw new NotPortedError("a concurrent download grant", SOURCE);
              throw error;
            }
          }
          return jsonRendered({ success: true, url_redirect: await serialize(loaded) });
        },
      );
    },
  },
  {
    method: "DELETE",
    pattern: "/internal/admin/url_redirects/:id/revoke_download",
    run: async (admin) => {
      const unauthorized = requirePerActorToken(admin.admin);
      if (unauthorized !== null) return halted(unauthorized);
      const loaded = await findUrlRedirect(admin);
      if (loaded === null) return notFound(NOT_FOUND);
      const delivery = await findFile(loaded, admin.params.product_file_id);
      if (delivery === null) return notFound("File not found");

      return recordAdminWrite(
        admin,
        { action: "url_redirects.revoke_download", target: target(loaded), wrapper: WRAPPER },
        async () => {
          await db.productFileDownloadGrant.deleteMany({
            where: { url_redirect_id: loaded.redirect.id, product_file_id: delivery.file.id },
          });
          return jsonRendered({ success: true, url_redirect: await serialize(loaded) });
        },
      );
    },
  },
);
