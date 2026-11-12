// Port of UrlRedirect#product_json_data (the url-redirect half of Purchase#json_data_for_mobile) for a redirect of a purchase whose
// files Node can list (url-redirects/files.ts hands back variants, rich content, preorders and stamped PDFs) and that has no
// media location, installment or subscription. Anything else throws, so the caller hands the request to Rails before writing.
import type { ProductFile, Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import type { Loaded } from "../controllers/url-redirects/access.ts";
import { aliveProductFiles, isFileDownloadable } from "../controllers/url-redirects/files.ts";
import { getConfig } from "../infra/config.ts";
import {
  isEpub,
  isExternalLink,
  isListenable,
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

export type UrlRedirectMobileData = { urlRedirectExternalId: string; urlRedirectToken: string; fileData: unknown[] };

export async function urlRedirectMobileData(loaded: Loaded & { purchase: Purchase }): Promise<UrlRedirectMobileData> {
  const { redirect, purchase } = loaded;
  if (redirect.installment_id !== null) throw new NotPortedError("a url redirect of a post");
  if (purchase.subscription_id !== null) throw new NotPortedError("the file_data of a membership");
  const files = await aliveProductFiles(loaded);
  if ((await db.mediaLocation.count({ where: { purchase_id: purchase.id } })) > 0)
    throw new NotPortedError("MediaLocation.max_consumed_at_by_file");

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
    json.latest_media_location = null;
    json.latest_epub_location = null;
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
