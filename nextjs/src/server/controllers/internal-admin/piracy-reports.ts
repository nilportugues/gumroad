// Api::Internal::Admin::PiracyReportsController#index (the piracy agent's queue). #show is in ./piracy-report-detail.ts and the writes
// in ./piracy-report-writes.ts.
import type { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { NotPortedError } from "../../models/user.ts";
import { failure, isBlank, jsonRendered, paramToS, PIRACY_SCOPE, timeJson } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";

const MAX_LIST_RESULTS = 100;
export const SOURCE = "app/controllers/api/internal/admin/piracy_reports_controller.rb";
// Time.zone.parse for an ISO 8601 timestamp or date (the zone is UTC); text with no digits parses to nil, and Rails keeps the rest.
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/u;

function parseTime(value: string): Date | null {
  const match = ISO_TIME.exec(value.trim());
  if (match === null) {
    if (/\d/u.test(value)) throw new NotPortedError("a timestamp that is not ISO 8601", SOURCE);
    return null;
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}${match[7] === undefined ? "" : `.${match[7].slice(0, 6)}`}${match[8] === undefined || match[8] === "Z" ? "Z" : match[8].replace(/^([+-]\d{2})(\d{2})$/u, "$1:$2")}`);
  // Time.zone.parse raises ArgumentError for an out-of-range field, which the controller rescues as nil.
  return Number.isNaN(date.getTime()) ? null : date;
}

export const dateJson = (date: Date | null) => (date === null ? null : date.toISOString().slice(0, 10));

export type Report = Prisma.PiracyReportGetPayload<{ include: { seller: { select: { external_id: true } }; product: { select: { id: true } } } }>;

// PiracyReport#blocked_on_recipient? and #needs_review?
const screening = (report: { state: string }) => report.state === "screening";

export function serializeSummary(report: Report) {
  return {
    report_id: report.external_id,
    state: report.state,
    blocked_on_recipient: screening(report) && report.screening_verdict === "pass",
    needs_review: screening(report) && report.screening_verdict === "review",
    sent_at: timeJson(report.sent_at),
    delivered_at: timeJson(report.delivered_at),
    delivery_failed_at: timeJson(report.delivery_failed_at),
    counter_notice_received_on: dateJson(report.counter_notice_received_on),
    outcome: report.outcome,
    source: report.source,
    url: report.url,
    user_id: report.seller.external_id,
    product_id: encrypt(report.product.id),
    ticket_url: report.ticket_url,
    created_at: timeJson(report.created_at),
    updated_at: timeJson(report.updated_at),
  };
}

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/piracy_reports",
  scope: PIRACY_SCOPE,
  run: async (admin) => {
    const where: Prisma.PiracyReportWhereInput = {};
    if (!isBlank(admin.params.state)) where.state = paramToS(admin.params.state, SOURCE);
    if ("reply_token" in admin.params) where.reply_token = !isBlank(admin.params.reply_token) ? paramToS(admin.params.reply_token, SOURCE) : { in: [] };

    if (!isBlank(admin.params.user_id)) {
      const user = await db.user.findFirst({ where: { external_id: paramToS(admin.params.user_id, SOURCE) }, select: { id: true } });
      if (user === null) return failure("User not found", 404);
      where.seller_id = user.id;
    }

    if (!isBlank(admin.params.after)) {
      const after = await db.piracyReport.findFirst({ where: { external_id: paramToS(admin.params.after, SOURCE) }, select: { id: true } });
      if (after === null) return failure("Piracy report not found", 404);
      where.id = { gte: after.id + 1n };
    }

    if (!isBlank(admin.params.updated_before)) {
      const updatedBefore = parseTime(paramToS(admin.params.updated_before, SOURCE));
      if (updatedBefore === null) return failure("updated_before must be a timestamp", 400);
      where.updated_at = { lt: updatedBefore };
    }

    const requested = Number.parseInt(paramToS(admin.params.limit, SOURCE), 10);
    const limit = requested > 0 ? Math.min(requested, MAX_LIST_RESULTS) : MAX_LIST_RESULTS;
    const reports = await db.piracyReport.findMany({
      where,
      orderBy: { id: "asc" },
      take: limit,
      include: { seller: { select: { external_id: true } }, product: { select: { id: true } } },
    });
    return jsonRendered({ success: true, reports: reports.map((report) => serializeSummary(report)) });
  },
});
