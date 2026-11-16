// CustomDomainConfig#set_user_and_custom_domain_config for a request that is not on the Gumroad
// domain: the seller whose subdomain or custom domain this is, or the 404.
import type { User } from "@prisma/client";

import { classifyHost } from "../../../lib/navigation/proxy/hosts.ts";
import { db } from "../../../lib/db.ts";
import { RoutingError } from "../../controllers/application-controller.ts";
import { isAccountActive, Users } from "../../models/user.ts";
import { domainConfig } from "../domain.ts";

// Subdomain.find_seller_by_hostname (`User.alive`) || CustomDomain.find_by_host(host).user
export async function userByDomain(hostname: string): Promise<User | null> {
  const host = classifyHost(hostname, domainConfig(process.env));
  if (host.sellerSubdomain) {
    const label = host.sellerSubdomain;
    const user = await db.user.findFirst({
      where: { deleted_at: null, ...("externalId" in label ? { external_id: label.externalId } : label.username === "" ? { id: -1 } : { username: label.username }) },
      orderBy: { id: "asc" },
    });
    if (user) return user;
  }
  for (const domain of host.customDomainLookup ?? []) {
    const custom = await db.customDomain.findFirst({ where: { deleted_at: null, domain }, orderBy: { id: "asc" } });
    if (custom) return custom.user_id === null ? null : db.user.findFirst({ where: { id: custom.user_id } });
  }
  return null;
}

// `error_if_user_not_found`: only an active account with a username is served; every format 404s.
export async function sellerOfHost(url: URL): Promise<User> {
  const user = await userByDomain(url.hostname);
  if (!user || !isAccountActive(Users.load(user))) throw new RoutingError("Not Found");
  return user;
}
