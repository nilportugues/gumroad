// Which of Rails' host constraints a request host satisfies, for the pages that live on seller
// subdomains and custom domains (config/routes.rb). The order is Rails': ProductCustomDomainConstraint's
// block comes before UserCustomDomainConstraint's, so a custom domain that has a product never reaches
// the seller routes.
import { Prisma } from "@prisma/client";

import { classifyHost } from "../lib/navigation/proxy/hosts.ts";
import { railsRequest } from "./controllers/rails-request.ts";
import { column, selectRows, table } from "./models/sql.ts";
import { domainConfig } from "./page-props/domain.ts";
import { redirectUrlFor } from "./services/subdomain-redirector.ts";

export type HostKind = "product" | "user" | null;

type CustomDomainRow = { user_id: number | null; product_id: bigint | null };

// CustomDomain.find_by_host: `alive.find_by(domain:)` for each candidate in turn.
async function findCustomDomain(candidates: string[]): Promise<CustomDomainRow | null> {
  for (const domain of candidates) {
    const [row] = await selectRows<CustomDomainRow>(
      Prisma.sql`SELECT ${column("custom_domains", "user_id")}, ${column("custom_domains", "product_id")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "deleted_at")} IS NULL AND ${column("custom_domains", "domain")} = ${domain} LIMIT 1`,
    );
    if (row) return row;
  }
  return null;
}

async function exists(tableName: string, where: Prisma.Sql): Promise<boolean> {
  return (await selectRows(Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${where} LIMIT 1`)).length > 0;
}

// Subdomain.find_seller_by_hostname: `User.alive`, by external id (a numeric label) or username.
async function sellerBySubdomain(label: { externalId: string } | { username: string }): Promise<boolean> {
  const alive = Prisma.sql`${column("users", "deleted_at")} IS NULL`;
  if ("externalId" in label) return exists("users", Prisma.sql`${alive} AND ${column("users", "external_id")} = ${label.externalId}`);
  if (label.username === "") return false;
  return exists("users", Prisma.sql`${alive} AND ${column("users", "username")} = ${label.username}`);
}

export async function hostKindOf(url: URL, headers: Headers): Promise<HostKind> {
  const config = domainConfig(process.env);
  const host = classifyHost(url.hostname, config);
  if (host.gumroad) return null;

  const custom = host.customDomainLookup ? await findCustomDomain(host.customDomainLookup) : null;
  if (custom?.product_id != null && (await exists("links", Prisma.sql`${column("links", "id")} = ${custom.product_id}`))) return "product";

  if (host.sellerSubdomain && (await sellerBySubdomain(host.sellerSubdomain))) return "user";
  if (custom?.user_id != null && (await exists("users", Prisma.sql`${column("users", "id")} = ${custom.user_id}`))) return "user";
  if ((await redirectUrlFor(railsRequest(new Request(url, { headers })))) !== undefined) return "user";
  return null;
}
