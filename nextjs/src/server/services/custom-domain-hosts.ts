// The seller's hosts as the profile pages read them: User#custom_html_store_hostnames and User#store_host_with_protocol.
import type { CustomDomain } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { subdomainFromUsername } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";

// CustomDomain::CERTIFICATE_LIFETIME and ROUTABILITY_REFRESH_INTERVAL
const CERTIFICATE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const ROUTABILITY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type HostSeller = { id: bigint; username: string | null; external_id: string | null };

// User#subdomain: the username, or the external id of a seller without one
const subdomainOf = (seller: HostSeller) =>
  subdomainFromUsername(seller.username?.trim() ? seller.username : seller.external_id);

// `user.custom_domain` (has_one, alive) when it is #active?: verified, with a certificate younger than its lifetime.
export async function activeCustomDomain(userId: bigint, now: Date): Promise<CustomDomain | null> {
  const domain = await db.customDomain.findFirst({
    where: { user_id: Number(userId), deleted_at: null },
    orderBy: { id: "asc" },
  });
  if (domain === null || domain.state !== "verified") return null;
  const issuedAt = domain.ssl_certificate_issued_at;
  return issuedAt !== null && issuedAt.getTime() > now.getTime() - CERTIFICATE_LIFETIME_MS ? domain : null;
}

// User#custom_html_store_hostnames
export async function customHtmlStoreHostnames(seller: HostSeller, now: Date): Promise<string[]> {
  const hostnames: string[] = [];
  const subdomain = subdomainOf(seller);
  // URI#host drops the port.
  if (subdomain !== null) hostnames.push(subdomain.replace(/:\d+$/u, ""));
  const custom = await activeCustomDomain(seller.id, now);
  if (custom?.domain != null) hostnames.push(custom.domain);
  return [...new Set(hostnames)];
}

// User#store_host_with_protocol. CustomDomain#strictly_routable? enqueues a refresh when the last check is stale; `refresh` is that
// job's argument, left to the caller so nothing is enqueued before the page it belongs to is known to render here.
export async function storeHostWithProtocol(
  seller: HostSeller,
  now: Date,
): Promise<{ host: string | null; refresh: number | null }> {
  const custom = await activeCustomDomain(seller.id, now);
  let refresh: number | null = null;
  if (custom !== null) {
    const checkedAt = custom.routability_checked_at;
    if (checkedAt === null || checkedAt.getTime() < now.getTime() - ROUTABILITY_REFRESH_INTERVAL_MS)
      refresh = custom.id;
    if (custom.routable === true && custom.domain != null)
      return { host: `${domainConfig(process.env).protocol}://${custom.domain}`, refresh };
  }
  const subdomain = subdomainOf(seller);
  return { host: subdomain === null ? null : `${domainConfig(process.env).protocol}://${subdomain}`, refresh };
}

export async function enqueueRoutabilityRefresh(refresh: number | null): Promise<void> {
  if (refresh !== null) await performAsync("RefreshCustomDomainRoutabilityWorker", [refresh]);
}
