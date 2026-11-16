// MediaLocationsController#create and the RecordMediaLocation concern (app/controllers/concerns/record_media_location.rb):
// where a buyer stopped in a video, audio file or book. An EPUB location with a CFI (its own validations) is left to Rails.
import { Prisma, type MediaLocation, type ProductFile, type Purchase, type UrlRedirect } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { truncateToSeconds } from "../models/concerns/ruby-time.ts";
import { defineModel } from "../models/runtime/define-model.ts";
import { validatesInclusionOf, validatesPresenceOf } from "../models/runtime/validators.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations } from "./mutation.ts";
import { isPresent } from "./rails-request.ts";

// Platform.all, MediaLocation::Unit
const PLATFORMS = ["web", "iphone", "android", "other"];
const UNIT_PAGE_NUMBER = "page_number";
const UNIT_SECONDS = "seconds";
const UNIT_PERCENTAGE = "percentage";

const MediaLocations = defineModel<MediaLocation>({
  rubyClass: "MediaLocation",
  prismaModel: "MediaLocation",
  delegate: (tx) => tx.mediaLocation as never,
  validations: [
    validatesPresenceOf(["url_redirect_id", "product_file_id", "purchase_id", "location", "product_id"]),
    validatesInclusionOf(["platform"], { in: PLATFORMS }),
  ],
});

const one = async <R>(model: Prisma.ModelName, name: string, where: Record<string, bigint | string | null>): Promise<R | null> => {
  const conditions = Object.entries(where).map(([key, value]) => (value === null ? Prisma.sql`${column(name, key)} IS NULL` : Prisma.sql`${column(name, key)} = ${value}`));
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`\`${name}\`.*`)} FROM ${table(name)} WHERE ${Prisma.join(conditions, " AND ")} LIMIT 1`);
  return row ? (castRow(model, row as never) as R) : null;
};

const idParam = (value: string): bigint | null => {
  const id = decrypt(value);
  return id === null ? null : BigInt(id);
};

// ISO 8601 with an explicit offset: the one shape `Time.zone.parse` reads the same as Date
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

// MediaLocation#add_unit for a non-EPUB-with-CFI file
function unitFor(file: ProductFile): string {
  if (file.filegroup === "video" || file.filegroup === "audio") return UNIT_SECONDS;
  if (file.filetype === "pdf" || file.filetype === "epub") return UNIT_PAGE_NUMBER;
  return UNIT_PERCENTAGE;
}

export async function recordMediaLocation(params: Record<string, unknown>, now: () => Date = () => new Date()): Promise<boolean> {
  const blank = (value: unknown) => value === undefined || value === null || value === "" || value === false || (typeof value === "string" && !isPresent(value));
  if (blank(params.url_redirect_id) || blank(params.product_file_id) || blank(params.location)) return false;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const urlRedirectParam = text(params.url_redirect_id);
  const productFileParam = text(params.product_file_id);
  const platform = text(params.platform);
  const location = typeof params.location === "number" && Number.isInteger(params.location) ? params.location : text(params.location) !== null && /^\d{1,9}$/u.test(params.location as string) ? Number(params.location) : null;
  if (urlRedirectParam === null || productFileParam === null || location === null) throw new HandBackToRails("a parameter that is not a plain string or integer");
  if (platform === null || !PLATFORMS.includes(platform)) return false;

  const urlRedirectId = idParam(urlRedirectParam);
  let purchaseId: bigint | null;
  if (!blank(params.purchase_id)) {
    const purchaseParam = text(params.purchase_id);
    if (purchaseParam === null) throw new HandBackToRails("a purchase_id that is not a string");
    purchaseId = idParam(purchaseParam);
  } else {
    const redirect = urlRedirectId === null ? null : await one<UrlRedirect>("UrlRedirect", "url_redirects", { id: urlRedirectId });
    if (!redirect) throw new RoutingError("Not Found");
    purchaseId = redirect.purchase_id;
  }
  const purchase = purchaseId === null ? null : await one<Purchase>("Purchase", "purchases", { id: purchaseId });
  const productId = purchase?.link_id == null ? null : ((await one<{ id: bigint }>("Link", "links", { id: purchase.link_id }))?.id ?? null);
  if (productId === null || purchaseId === null) return false;

  if (!blank(params.consumed_at) && (typeof params.consumed_at !== "string" || !ISO_WITH_ZONE.test(params.consumed_at))) throw new HandBackToRails("a consumed_at Node does not parse");
  const consumedAt = truncateToSeconds(blank(params.consumed_at) ? now() : new Date(params.consumed_at as string));
  const fileId = idParam(productFileParam);
  const file = fileId === null ? null : await one<ProductFile>("ProductFile", "product_files", { id: fileId });
  if (!file) throw new RoutingError("Not Found");
  const consumable = file.filegroup === "video" || file.filegroup === "audio" || file.filetype === "pdf" || file.filetype === "epub";
  if (!consumable) return false;
  // epub_cfi is only read for an EPUB, and has its own length, format and percentage rules.
  if (file.filetype === "epub" && !blank(params.epub_cfi)) throw new HandBackToRails("an EPUB location with a CFI");

  const key = { url_redirect_id: urlRedirectId!, purchase_id: purchaseId, product_file_id: file.id, product_id: productId, platform };
  const existing = await one<MediaLocation>("MediaLocation", "media_locations", key);
  // `consumed_at > media_location.consumed_at` raises (a 500) against a row without one
  if (existing && existing.consumed_at === null) throw new HandBackToRails("a media location without consumed_at");
  if (existing && consumedAt.getTime() <= existing.consumed_at!.getTime()) return false;

  const attributes = { location, epub_cfi: null, consumed_at: consumedAt, unit: unitFor(file) };
  if (existing) await MediaLocations.updateBang(MediaLocations.load(existing), attributes, { now });
  else await MediaLocations.createBang({ ...key, ...attributes }, { now });
  return true;
}

registerMutations({
  method: "POST",
  pattern: "/media_locations",
  formats: ["html", "json"],
  // skip_before_action :check_suspended
  options: { skip: ["check_suspended"] },
  run: async ({ params }): Promise<ActionResult> => json({ success: await recordMediaLocation(params) }),
});
