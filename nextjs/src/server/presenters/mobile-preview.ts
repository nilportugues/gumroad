// The cover fields of Product::AsJson#as_json_for_mobile_api (Product::Preview#preview_url, #mobile_oembed_url,
// #preview_height_for_mobile, #preview_width_for_mobile and Link#thumbnail_or_cover_url). A cover that is an Unsplash photo or an
// oEmbed document is a row alone; a product with an uploaded cover stays with Rails, since its URL enqueues the retina job once per read
// in a way that depends on which fields the serializer reads.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { uploadedFiles } from "./asset-preview-upload.ts";
import { coverAsJson, type CoverRow } from "./asset-preview.ts";

// Product::Preview::DEFAULT_MOBILE_PREVIEW_HEIGHT: a shorter preview is reported as no height.
const DEFAULT_MOBILE_PREVIEW_HEIGHT = 204;

// OEmbedFinder::MOBILE_URL_REGEXES
const MOBILE_URL_REGEXES = [
  /player.vimeo.com\/video\/\d+/u,
  /https:\/\/w.soundcloud.com\/player/u,
  /https:\/\/www.youtube.com\/embed/u,
];

export type MobilePreview = {
  previewUrl: string;
  previewOembedUrl: string;
  previewHeight: number;
  previewWidth: number;
};

const unsplashPresent = (row: CoverRow) => row.unsplash_url !== null && row.unsplash_url.trim() !== "";

// The preview fields and `thumbnail_or_cover_url` of a product, or null preview fields for a product without a cover.
export async function mobilePreview(
  productId: bigint,
  thumbnailUrl: string | null,
): Promise<{ preview: MobilePreview | null; thumbnailOrCoverUrl: string | null }> {
  const rows = await selectRows<CoverRow & { id: bigint }>(
    Prisma.sql`SELECT ${column("asset_previews", "id")}, ${column("asset_previews", "guid")}, ${column("asset_previews", "oembed")}, ${column("asset_previews", "unsplash_url")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${productId} AND ${column("asset_previews", "deleted_at")} IS NULL ORDER BY ${column("asset_previews", "position")} ASC, ${column("asset_previews", "created_at")} ASC`,
  );
  if (rows.length === 0) return { preview: null, thumbnailOrCoverUrl: thumbnailUrl };
  if ((await uploadedFiles(rows.map((row) => row.id))).size > 0)
    throw new NotPortedError("Link#as_json(mobile: true) for a product with an uploaded cover");

  const main = rows[0]!;
  // `oembed_url` is read from the oEmbed document, `url` from the photo first.
  if (main.oembed !== null && main.unsplash_url !== null)
    throw new NotPortedError("Link#as_json(mobile: true) for a cover that is both a photo and an oEmbed document");
  const cover = coverAsJson(main);
  const url = cover.url as string | null;
  const oembedUrl = main.oembed === null ? null : url;
  const height = (cover.height as number | null) ?? 0;

  // thumbnail_alive&.url || display_asset_previews.find(&:image_url?)&.url
  let thumbnailOrCoverUrl = thumbnailUrl;
  if (thumbnailOrCoverUrl === null) {
    const photo = rows.find(unsplashPresent);
    if (photo) thumbnailOrCoverUrl = coverAsJson(photo).url as string | null;
  }

  return {
    preview: {
      // preview_oembed_thumbnail_url || preview_url || ""
      previewUrl: (cover.thumbnail as string | null) ?? url ?? "",
      previewOembedUrl:
        oembedUrl !== null && MOBILE_URL_REGEXES.some((regex) => regex.test(oembedUrl)) ? oembedUrl : "",
      previewHeight: height < DEFAULT_MOBILE_PREVIEW_HEIGHT ? 0 : height,
      previewWidth: (cover.width as number | null) ?? 0,
    },
    thumbnailOrCoverUrl,
  };
}
