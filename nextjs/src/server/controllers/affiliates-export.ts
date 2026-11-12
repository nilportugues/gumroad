// AffiliatesController#export (GET /affiliates/export, app/controllers/affiliates_controller.rb) and the synchronous half of
// Exports::AffiliateExportService: up to SYNCHRONOUS_EXPORT_THRESHOLD live affiliates are streamed as a CSV, more are left to
// Exports::AffiliateExportWorker and the seller is told to expect an email.
//
// A request that carries a Referer hands back: `redirect_back` follows it only for the same host, which is not judged here.
import { Prisma } from "@prisma/client";

import { encryptNumeric } from "../../lib/obfuscate-ids.ts";
import {
  type AffiliateRow,
  affiliateExportCsv,
  affiliateExportFilename,
  runsSynchronously,
} from "../exports/affiliate-export.ts";
import { exportAffiliatesOrEnqueue } from "../exports/enqueue.ts";
import { calendarDateInTimeZone } from "../models/concerns/rails-time-zone.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { directAffiliatePolicy } from "../policies/direct-affiliate.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requireHtml } from "./users-controller.ts";

const FOUND = 302;
const FALLBACK_LOCATION = "/affiliates";
const EMAIL_NOTICE = "You will receive an email with the data you've requested.";
const PAD = (value: number) => String(value).padStart(2, "0");

type Row = {
  id: bigint;
  destination_url: string | null;
  affiliate_basis_points: number | null;
  created_at: Date;
  name: string | null;
  username: string | null;
  email: string | null;
  timezone: string;
};

// `DirectAffiliate#total_amount_cents`: the credits on the affiliate's own products, over the purchases that count towards volume
// (successful, not fully refunded, not charged back unless reversed). The bare `price_cents` is the purchase's.
async function affiliateRows(sellerId: bigint): Promise<AffiliateRow[]> {
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${column("affiliates", "id")}, ${column("affiliates", "destination_url")}, ${column("affiliates", "affiliate_basis_points")}, ${column("affiliates", "created_at")}, ${column("users", "name")}, ${column("users", "username")}, ${column("users", "email")}, ${column("users", "timezone")} FROM ${table("affiliates")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("affiliates", "affiliate_user_id")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "seller_id")} = ${sellerId} AND ${column("affiliates", "deleted_at")} IS NULL ORDER BY ${column("affiliates", "id")}`,
  );
  const config = domainConfig(process.env);
  const result: AffiliateRow[] = [];
  for (const row of rows) {
    const products = await selectRows<{ id: bigint; name: string | null }>(
      Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} INNER JOIN ${table("affiliates_links")} ON ${column("links", "id")} = ${column("affiliates_links", "link_id")} WHERE ${column("affiliates_links", "affiliate_id")} = ${row.id} ORDER BY ${column("links", "id")}`,
    );
    const [sales] =
      products.length === 0
        ? [{ cents: 0n }]
        : await selectRows<{ cents: bigint | null }>(
            Prisma.sql`SELECT COALESCE(SUM(${column("purchases", "price_cents")}), 0) AS cents FROM ${table("affiliate_credits")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("affiliate_credits", "purchase_id")} WHERE ${column("affiliate_credits", "affiliate_id")} = ${row.id} AND ${column("affiliate_credits", "link_id")} IN (${Prisma.join(products.map((product) => product.id))}) AND ${column("purchases", "purchase_state")} = 'successful' AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) AND (${column("purchases", "chargeback_date")} IS NULL OR (${column("purchases", "chargeback_date")} IS NOT NULL AND ${PurchaseFlags.condition("chargeback_reversed")}))`,
          );
    const created = calendarDateInTimeZone(row.timezone, row.created_at);
    result.push({
      externalIdNumeric: encryptNumeric(Number(row.id)),
      name: row.name,
      username: row.username ?? "",
      email: row.email ?? "",
      affiliatePercentage: row.affiliate_basis_points === null ? 0 : Math.floor(row.affiliate_basis_points / 100),
      salesCents: Number(sales?.cents ?? 0),
      productNames: products.map((product) => product.name ?? ""),
      referralUrl: `${config.protocol}://${config.rootDomain}/a/${encryptNumeric(Number(row.id))}`,
      destinationUrl: row.destination_url,
      createdOn: `${created.year}-${PAD(created.month)}-${PAD(created.day)}`,
    });
  }
  return result;
}

async function exportAffiliates(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const redirect = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (context) => authorize(directAffiliatePolicy.index, context),
  );
  if (redirect !== null) return redirect;

  const seller = input.context.currentSeller!;
  const [count] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "seller_id")} = ${seller.id} AND ${column("affiliates", "deleted_at")} IS NULL`,
  );
  const recipient = input.context.impersonatedUser ?? seller;
  const liveAffiliateCount = Number(count!.count);
  if (!runsSynchronously(liveAffiliateCount)) {
    if (input.request.headers.get("referer"))
      throw new HandBackToRails("a request with a Referer, which redirect_back may follow");
    await exportAffiliatesOrEnqueue({
      sellerId: BigInt(seller.id),
      recipientId: BigInt(recipient.id),
      liveAffiliateCount,
    });
    return { status: FOUND, location: FALLBACK_LOCATION, flash: { warning: EMAIL_NOTICE } };
  }

  const csv = affiliateExportCsv(await affiliateRows(BigInt(seller.id)));
  const filename = affiliateExportFilename(seller.username ?? "", input.chain.now);
  return {
    status: 200,
    body: csv,
    contentType: "text/csv",
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Transfer-Encoding": "binary",
    },
  };
}

registerMutations({ method: "GET", pattern: "/affiliates/export", skipForgeryProtection: true, run: exportAffiliates });
