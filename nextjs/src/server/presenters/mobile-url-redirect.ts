// Port of UrlRedirect#product_json_data (the url-redirect half of Purchase#json_data_for_mobile) for a redirect of a purchase whose
// files Node can list (url-redirects/files.ts hands back several or shared versions, rich content, preorders and stamped PDFs) and
// that has no installment. A purchased version lists its own files, as on the download page. The latest media location of each file is ported. Anything else throws, so the caller hands the request to Rails before writing.
import type { MediaLocation, ProductFile, Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import type { Loaded } from "../controllers/url-redirects/access.ts";
import { aliveProductFiles, isFileDownloadable } from "../controllers/url-redirects/files.ts";
import { getConfig } from "../infra/config.ts";
import {
  isEpub,
  isExternalLink,
  isListenable,
  isPdf,
  isStreamable,
  filenameWithExtension,
  type S3Fields,
} from "../models/product-file.ts";
import { nameDisplayable } from "../page-props/audience/product-file-json.ts";
import { domainConfig } from "../page-props/domain.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { jsonTime } from "./mobile-serializers.ts";

// ProductFile#filename_with_extension for a file outside S3 (an external link): `"#{nil}.#{filetype}"`, nil without a filetype.
const mobileFilename = (file: ProductFile, s3: S3Fields | null) =>
  s3 === null
    ? file.filetype === null || file.filetype === ""
      ? null
      : `.${file.filetype}`
    : filenameWithExtension(file, s3);

// MediaLocation::Unit
const UNIT_SECONDS = "seconds";
const UNIT_PERCENTAGE = "percentage";
const UNIT_PAGE_NUMBER = "page_number";
// The spine step of an EPUB CFI: ProductFile#epub_location_for_mobile's /\Aepubcfi\(\/\d+(?:\[[^\]\r\n]*\])?\/(\d+)/
const EPUB_SPINE_STEP = /^epubcfi\(\/\d+(?:\[[^\]\r\n]*\])?\/(\d+)/u;
const FULL_PERCENTAGE = 100;

// MediaLocation.max_consumed_at_by_file(purchase_id:).index_by(&:product_file_id): the row with the latest consumed_at of each file (a
// row without one never joins). Two rows tied on it come back in no defined order, and index_by keeps the last, so that is Rails'.
async function latestLocationsByFile(purchaseId: bigint): Promise<Map<bigint, MediaLocation>> {
  const rows = await db.mediaLocation.findMany({ where: { purchase_id: purchaseId, consumed_at: { not: null } } });
  const latest = new Map<bigint, MediaLocation[]>();
  for (const row of rows) {
    const current = latest.get(row.product_file_id);
    const best = current?.[0]?.consumed_at?.getTime();
    const at = row.consumed_at!.getTime();
    if (current === undefined || at > best!) latest.set(row.product_file_id, [row]);
    else if (at === best) current.push(row);
  }
  const result = new Map<bigint, MediaLocation>();
  for (const [fileId, tied] of latest) {
    if (tied.length > 1) throw new NotPortedError("media locations that share the latest consumed_at");
    result.set(fileId, tied[0]!);
  }
  return result;
}

// ProductFile#media_location_compatible?
function mediaLocationCompatible(file: ProductFile, location: MediaLocation): boolean {
  if (isListenable(file) || isStreamable(file)) return location.unit === UNIT_SECONDS;
  if (isEpub(file)) return location.unit === UNIT_PAGE_NUMBER || location.unit === UNIT_PERCENTAGE;
  if (isPdf(file)) return location.unit === UNIT_PAGE_NUMBER;
  return false;
}

// ProductFile#epub_location_for_mobile
function epubLocationForMobile(file: ProductFile, location: MediaLocation | undefined) {
  if (location === undefined || !isEpub(file) || location.unit !== UNIT_PERCENTAGE) return null;
  const pagelength = file.pagelength ?? 0;
  if (pagelength <= 0) return null;
  const captured = location.epub_cfi === null ? null : EPUB_SPINE_STEP.exec(location.epub_cfi)?.[1];
  if (captured === undefined || captured === null) return null;
  const spineStep = Number(captured);
  if (spineStep % 2 !== 0) return null;
  const pageNumber = spineStep / 2;
  if (pageNumber < 1 || pageNumber > pagelength) return null;
  return {
    cfi: location.epub_cfi,
    percentage: location.location,
    page_number: pageNumber,
    completed: location.location === FULL_PERCENTAGE,
    timestamp: jsonTime(location.consumed_at),
  };
}

// ProductFile#media_location_for_mobile
function mediaLocationForMobile(file: ProductFile, location: MediaLocation | undefined) {
  if (location === undefined || !mediaLocationCompatible(file, location)) return null;
  if (!isEpub(file) || location.unit !== UNIT_PERCENTAGE)
    return { location: location.location, unit: location.unit, timestamp: jsonTime(location.consumed_at) };
  const epub = epubLocationForMobile(file, location);
  if (epub === null) return null;
  const pagelength = file.pagelength ?? 0;
  let pageNumber = epub.completed ? pagelength : epub.page_number;
  if (!epub.completed) {
    if (pagelength === 1) return null;
    if (pageNumber === pagelength) pageNumber -= 1;
  }
  return { location: pageNumber, unit: UNIT_PAGE_NUMBER, timestamp: jsonTime(location.consumed_at) };
}

export type UrlRedirectMobileData = { urlRedirectExternalId: string; urlRedirectToken: string; fileData: unknown[] };

export async function urlRedirectMobileData(loaded: Loaded & { purchase: Purchase }): Promise<UrlRedirectMobileData> {
  const { redirect, purchase } = loaded;
  if (redirect.installment_id !== null) throw new NotPortedError("a url redirect of a post");
  const files = await aliveProductFiles(loaded, undefined, { versions: true });
  // UrlRedirect#latest_mobile_media_locations_by_product_file_id: only the locations of alive files they fit
  const locations = new Map<bigint, MediaLocation>();
  for (const [fileId, location] of await latestLocationsByFile(purchase.id)) {
    const delivery = files.find((candidate) => candidate.file.id === fileId);
    if (delivery !== undefined && mediaLocationCompatible(delivery.file, location)) locations.set(fileId, location);
  }

  const config = domainConfig(process.env);
  const apiOrigin = `${config.protocol}://${config.apiDomain}`;
  const mobileToken = getConfig("MOBILE_TOKEN");
  const fileData: unknown[] = [];
  for (const delivery of files) {
    const { file, s3 } = delivery;
    const json: Record<string, unknown> = {
      name: mobileFilename(file, s3),
      size: file.size === null ? null : Number(file.size),
      filetype: file.filetype,
      filegroup: file.filegroup,
      id: encrypt(file.id),
      created_at: jsonTime(file.created_at),
      name_displayable: nameDisplayable(file, s3),
      description: file.description,
      pagelength: isEpub(file) ? null : file.pagelength,
      duration: file.duration,
    };
    if (await isFileDownloadable(loaded, delivery))
      json.download_url = `${apiOrigin}/mobile/url_redirects/download/${redirect.token}/${encrypt(file.id)}?mobile_token=${mobileToken}`;
    json.latest_media_location = mediaLocationForMobile(file, locations.get(file.id));
    json.latest_epub_location = epubLocationForMobile(file, locations.get(file.id));
    json.content_length = isEpub(file)
      ? file.pagelength
      : isListenable(file) || isStreamable(file)
        ? file.duration
        : file.pagelength;
    if (isStreamable(file))
      json.streaming_url = `${apiOrigin}/mobile/url_redirects/stream/${redirect.token}/${encrypt(file.id)}`;
    if (isExternalLink(file)) json.external_link_url = file.url;
    fileData.push(json);
  }
  return { urlRedirectExternalId: encrypt(redirect.id), urlRedirectToken: redirect.token, fileData };
}
