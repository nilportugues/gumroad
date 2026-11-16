// ProductFilesUtilityController (app/controllers/product_files_utility_controller.rb): the product editor's file helpers.
//
// Handed to Rails: `external_link_title` for any url Rails would fetch (Node has no SSRF-filtered fetch the replays can prove), the
// download of more than one file (the library query groups by url, so the row order is MySQL's), of a file whose url another row of
// the library shares, and the folder archive of a version.
import { Prisma, type Link, type ProductFile } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { signedDownloadUrlForS3KeyAndFilename } from "../infra/signed-urls.ts";
import { filenameWithExtension, isExternalLink, isStreamable, s3Fields } from "../models/product-file.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import { loadSellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import { cgiEscape, requestFormat } from "./rails-params.ts";
import { signedOutRefusal } from "./wishlists-mutations.ts";

const NO_LONGER_AVAILABLE = "This file is no longer available. Please re-upload it.";
// SsrfFilter::IPV4_BLACKLIST
const BLOCKED_IPV4: [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
  [0xffffffff, 32],
];

function blockedIpv4(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return BLOCKED_IPV4.some(([base, bits]) => address >>> (32 - bits) === base >>> (32 - bits));
}

// GET /product_files_utility/external_link_title
function externalLinkTitle(input: MutationInput): ActionResult {
  const refused = signedOutRefusal(input);
  if (refused) return refused;
  const failure = jsonResponse({ success: false }, 200, true);
  const url = input.params.url;
  // `params.require(:url)` raises on a blank value and the method's rescue answers the failure.
  if (url === undefined || url === null || url === "") return failure;
  if (typeof url !== "string") throw new HandBackToRails("a url param that is not text");
  const match = /^(https?):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::\d*)?(?:[/?#]|$)/iu.exec(url);
  // A scheme SsrfFilter refuses, or a url URI cannot parse, is a rescued exception.
  if (match === null || /\s/u.test(url)) return failure;
  const host = match[2]!.toLowerCase();
  if (host === "localhost" || host === "[::1]" || blockedIpv4(host) === true) return failure;
  throw new HandBackToRails("a url Rails fetches with SsrfFilter");
}

type Located = { product: Link; sellerContext: Awaited<ReturnType<typeof loadSellerContext>> };

// `set_product`: `Link.find_by_external_id`, `product_accessible_by_current_user?` and `authorize @product, :edit?`.
async function setProduct(input: MutationInput, externalId: string | undefined): Promise<Located | ActionResult> {
  const id = externalId === undefined ? null : decrypt(externalId);
  const product = id === null ? null : await db.link.findFirst({ where: { id: BigInt(id) } });
  const seller = input.context.currentSeller;
  if (seller === null) throw new HandBackToRails("a signed-in request without a current seller");
  const sellerContext = await loadSellerContext(input.context);
  if (product === null) throw new RoutingError("Not Found");
  const collaborating = await collaboratingProductIds(sellerContext, [product.id]);
  if (product.user_id === null || BigInt(product.user_id) !== BigInt(seller.id)) {
    if (!collaborating.has(BigInt(product.id))) throw new RoutingError("Not Found");
  }
  if (!(await linkPolicy.edit(sellerContext, product, collaborating))) {
    const message = notAllowedMessage(sellerContext);
    if (requestFormat(input.request) === "json")
      return { ...jsonResponse({ success: false, error: message }, 401, true), rescued: true };
    return {
      status: 302,
      location: Routes.dashboard_url(input.urlOptions),
      rescued: true,
      ...(input.url.searchParams.get("account_switched") ? {} : { flash: { alert: message } }),
    };
  }
  return { product, sellerContext };
}

const isLocated = (value: Located | ActionResult): value is Located => "sellerContext" in value;

// `Array.wrap(params[:product_file_ids]).map { from_external_id }`: ids that do not decrypt are `nil`, which matches nothing.
function requestedIds(value: unknown): bigint[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some((item) => typeof item !== "string")) throw new HandBackToRails("product_file_ids that are not text");
  return (list as string[]).flatMap((item) => {
    const id = decrypt(item);
    return id === null ? [] : [BigInt(id)];
  });
}

// `downloadable_product_files.by_external_ids(ids)`, for a request that names one file whose url no other row of the library shares.
async function downloadableFile(
  product: Link,
  owner: bigint,
  ids: bigint[],
  viaSeller: boolean,
): Promise<ProductFile[]> {
  if (ids.length === 0) return [];
  const own = await db.productFile.findMany({ where: { link_id: product.id, deleted_at: null } });
  const urls = own.map((file) => file.url).filter((url): url is string => url !== null);
  const library = await selectRows<{ id: bigint; url: string | null; link_id: bigint | null }>(
    Prisma.sql`SELECT ${column("product_files", "id")}, ${column("product_files", "url")}, ${column("product_files", "link_id")} FROM ${table("product_files")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_files", "link_id")} WHERE ${column("links", "user_id")} = ${owner} AND ${column("links", "deleted_at")} IS NULL AND ${column("product_files", "deleted_at")} IS NULL`,
  );
  const candidates = new Map<string, { id: bigint; url: string | null; link_id: bigint | null }>();
  for (const row of own) candidates.set(String(row.id), row);
  for (const row of library) {
    if (urls.length > 0 && (row.link_id === product.id || (row.url !== null && urls.includes(row.url)))) continue;
    candidates.set(String(row.id), row);
  }
  const wanted = ids.flatMap((id) => (candidates.has(String(id)) ? [candidates.get(String(id))!] : []));
  const scoped = viaSeller ? wanted : wanted.filter((row) => row.link_id === product.id);
  if (scoped.length > 1) throw new HandBackToRails("several files, whose order is the group-by order of MySQL");
  const [only] = scoped;
  if (only === undefined) return [];
  // `group(:url)` keeps one row per url: another candidate with this url makes the pick arbitrary.
  if ([...candidates.values()].some((row) => row.id !== only.id && row.url === only.url))
    throw new HandBackToRails("a file whose url another row of the library shares");
  const file = await db.productFile.findFirst({ where: { id: only.id } });
  return file === null ? [] : [file];
}

async function ownerExternalId(userId: bigint | null): Promise<string | null> {
  const user = userId === null ? null : await db.user.findFirst({ where: { id: userId } });
  return user?.external_id ?? null;
}

class StorageObjectMissing extends Error {}

// `url_redirect.signed_location_for_file(file, allow_unstamped: true)` of an unsaved redirect, which has no stamped copies.
async function signedLocation(file: ProductFile, owner: string | null): Promise<string> {
  if (isExternalLink(file)) return file.url ?? "";
  const fields = s3Fields(file.url, owner);
  if (fields === null) throw new HandBackToRails("a product file whose url is not on S3");
  const filename =
    fields.extension === ""
      ? `${fields.filename}${filenameExtname(filenameWithExtension(file, fields))}`
      : fields.filename;
  try {
    return await signedDownloadUrlForS3KeyAndFilename(fields.key, filename, { isVideo: isStreamable(file) });
  } catch (error) {
    const notFound =
      (error as { name?: string }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
    if (!notFound) throw error;
    throw new StorageObjectMissing(fields.key);
  }
}

// File.extname
function filenameExtname(name: string | null): string {
  if (name === null) return "";
  const base = name.split("/").at(-1)!;
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot);
}

// GET /product_files_utility/product_files/:product_id
async function downloadProductFiles(input: MutationInput): Promise<ActionResult> {
  const refused = signedOutRefusal(input);
  if (refused) return refused;
  const located = await setProduct(input, input.routeParams.product_id);
  if (!isLocated(located)) return located;
  const { product } = located;
  const json = requestFormat(input.request) === "json";
  if (!json && requestFormat(input.request) === "other")
    throw new HandBackToRails("a download request in a format other than html and json");
  const seller = input.context.currentSeller!;
  const files = await downloadableFile(
    product,
    product.user_id ?? 0n,
    requestedIds(input.params.product_file_ids),
    product.user_id !== null && BigInt(product.user_id) === BigInt(seller.id),
  );
  if (files.length === 0) throw new RoutingError("Not Found");
  const file = files[0]!;
  const owner = await ownerExternalId(product.user_id);
  try {
    const location = await signedLocation(file, owner);
    if (json) {
      const fields = s3Fields(file.url, owner);
      return jsonResponse({ files: [{ url: location, filename: filenameWithExtension(file, fields) }] }, 200, true);
    }
    return { status: 302, location };
  } catch (error) {
    if (!(error instanceof StorageObjectMissing)) throw error;
    if (json) return jsonResponse({ error: NO_LONGER_AVAILABLE }, 404, true);
    return {
      status: 302,
      location: Routes.edit_link_url(product.unique_permalink, input.urlOptions),
      flash: { warning: NO_LONGER_AVAILABLE },
    };
  }
}

// GET /product_files_utility/folder_archive/:folder_id
async function downloadFolderArchive(input: MutationInput): Promise<ActionResult> {
  const refused = signedOutRefusal(input);
  if (refused) return refused;
  const productId = input.params.product_id;
  if (productId !== undefined && typeof productId !== "string")
    throw new HandBackToRails("a product_id that is not text");
  const located = await setProduct(input, productId);
  if (!isLocated(located)) return located;
  const { product } = located;
  const variantId = input.params.variant_id;
  if (variantId !== undefined && variantId !== null && variantId !== "")
    throw new HandBackToRails("a folder archive of a version");
  const folderId = input.routeParams.folder_id!;
  const json = requestFormat(input.request) === "json";
  if (!json && requestFormat(input.request) === "other")
    throw new HandBackToRails("a download request in a format other than html and json");
  // `latest_ready_folder_archive`: `folder_archives.alive.ready.where(folder_id:).last`
  const archive = await db.productFilesArchive.findFirst({
    where: { link_id: product.id, folder_id: folderId, deleted_at: null, product_files_archive_state: "ready" },
    orderBy: { id: "desc" },
  });
  if (json) {
    if (archive === null) return jsonResponse({ url: null }, 200, true);
    const origin = `${input.urlOptions.protocol}://${input.urlOptions.host}`;
    return jsonResponse(
      {
        url: `${origin}/product_files_utility/folder_archive/${railsSegment(folderId)}?product_id=${cgiEscape(String(productId))}`,
      },
      200,
      true,
    );
  }
  if (archive === null) throw new RoutingError("Not Found");
  const fields = s3Fields(archive.url, await ownerExternalId(product.user_id));
  if (fields === null) throw new HandBackToRails("an archive whose url is not on S3");
  return { status: 302, location: await signedDownloadUrlForS3KeyAndFilename(fields.key, fields.filename) };
}

registerMutations(
  {
    method: "GET",
    pattern: "/product_files_utility/external_link_title",
    skipForgeryProtection: true,
    run: async (input) => externalLinkTitle(input),
  },
  {
    method: "GET",
    pattern: "/product_files_utility/product_files/:product_id",
    skipForgeryProtection: true,
    run: downloadProductFiles,
  },
  {
    method: "GET",
    pattern: "/product_files_utility/folder_archive/:folder_id",
    skipForgeryProtection: true,
    run: downloadFolderArchive,
  },
);
