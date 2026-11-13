// Api::Internal::Admin::PiracyReportsController#show and serialize_detail (also the body of a screen answer).
import type { Link, Prisma, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { s3Fields } from "../../models/product-file.ts";
import { NotPortedError } from "../../models/user.ts";
import { nameDisplayable } from "../../page-props/audience/product-file-json.ts";
import { eligibilityErrors, longUrl } from "../../page-props/piracy-reports/pages.ts";
import { failure, halted, isBlank, jsonRendered, paramToS, PIRACY_SCOPE, timeJson } from "./base.ts";
import { serializeSummary, SOURCE } from "./piracy-reports.ts";
import { defineAdminRoute } from "./registry.ts";

export const REPORT_NOT_FOUND = "Piracy report not found";
const MAX_PRODUCT_FILES = 50;
const MAX_DESCRIPTION_LENGTH = 2000;
const TRUNCATION_OMISSION = "...";
// strip_tags(...).squish.truncate: the sanitizer's treatment of scripts and of entities other than &amp; (which it writes back
// unchanged) is not reproduced, so only plain text, &amp; and ordinary formatting tags are served.
const SIMPLE_TAG = /<\/?(?:p|br|strong|em|b|i|u|s|ul|ol|li|h[1-6]|a|div|span|blockquote|code|pre|hr)(?:\s[^<>&]*)?\/?>/giu;
const WHITE_SPACE_RUN = /\p{White_Space}+/gu;

export function descriptionFact(description: string | null): string {
  const text = (description ?? "").replace(SIMPLE_TAG, "");
  if (/[<>]|&(?!amp;)/u.test(text)) throw new NotPortedError("a product description with markup the tag stripper treats specially", SOURCE);
  const characters = [...text.replace(WHITE_SPACE_RUN, " ").trim()];
  return characters.length > MAX_DESCRIPTION_LENGTH ? `${characters.slice(0, MAX_DESCRIPTION_LENGTH - TRUNCATION_OMISSION.length).join("")}${TRUNCATION_OMISSION}` : characters.join("");
}

async function productFacts(product: Link, seller: User) {
  const description = descriptionFact(product.description);
  const files = await db.productFile.findMany({ where: { link_id: product.id, deleted_at: null }, orderBy: { id: "asc" }, take: MAX_PRODUCT_FILES });
  const successful = { link_id: product.id, purchase_state: "successful" };
  const first = await db.purchase.aggregate({ where: successful, _min: { created_at: true } });
  return {
    name: product.name,
    url: longUrl(product, seller),
    description,
    created_at: timeJson(product.created_at),
    files: files.map((file) => ({ name: nameDisplayable(file, s3Fields(file.url, seller.external_id)), filetype: file.filetype, size: file.size === null ? null : Number(file.size) })),
    successful_sales_count: await db.purchase.count({ where: successful }),
    first_sale_at: timeJson(first._min.created_at),
  };
}

export type DetailReport = Prisma.PiracyReportGetPayload<{ include: { seller: true; product: true } }>;

export async function serializeDetail(report: DetailReport) {
  return {
    ...serializeSummary(report),
    seller_name: isBlank(report.seller.name) ? null : report.seller.name,
    product: await productFacts(report.product, report.seller),
    eligibility_errors: await eligibilityErrors(report.seller, report.product),
    screening_verdict: report.screening_verdict,
    screening_checks: report.screening_checks,
    screened_at: timeJson(report.screened_at),
    recipient: { name: report.recipient_name, email: report.recipient_email, source_url: report.recipient_source_url },
    // The notice holds the seller's legal name and email; the agent gets only its digest.
    notice_digest: report.notice_digest,
  };
}

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/piracy_reports/:id",
  scope: PIRACY_SCOPE,
  run: async (admin) => {
    const report = await db.piracyReport.findFirst({ where: { external_id: paramToS(admin.params.id, SOURCE) }, include: { seller: true, product: true } });
    if (report === null) return halted(failure(REPORT_NOT_FOUND, 404));
    return jsonRendered({ success: true, report: await serializeDetail(report) });
  },
});
