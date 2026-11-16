// The User and Link readers the buyer pages' presenters share.
import type { Link, User } from "@prisma/client";

import { domainConfig } from "../domain.ts";
import { nameOrUsername, subdomainWithProtocol, Users } from "../../models/user.ts";
import { cgiEscape } from "../../controllers/rails-params.ts";

export { avatarUrl } from "../signed-in/presenters.ts";

export const userNameOrUsername = (user: User) => nameOrUsername(Users.load(user));

export const userSubdomainWithProtocol = (user: User) => subdomainWithProtocol(Users.load(user));

// User#profile_url(recommended_by:): `URI(subdomain_with_protocol)` with a query.
export function profileUrl(user: User, { recommendedBy }: { recommendedBy?: string } = {}): string {
  const base = userSubdomainWithProtocol(user);
  if (base === null) throw new TypeError("no implicit conversion of nil into String");
  return recommendedBy ? `${base}?recommended_by=${cgiEscape(recommendedBy)}` : base;
}

// Link#general_permalink
const generalPermalink = (product: Link) => (product.custom_permalink && product.custom_permalink.trim() !== "" ? product.custom_permalink : product.unique_permalink);

// Link#long_url(recommended_by:): short_link_url(general_permalink, host:, recommended_by:).
export function productLongUrl(product: Link, seller: User, { recommendedBy }: { recommendedBy?: string } = {}): string {
  const host = userSubdomainWithProtocol(seller) ?? `${domainConfig(process.env).protocol}://${domainConfig(process.env).domain}`;
  const query = recommendedBy ? `?recommended_by=${cgiEscape(recommendedBy)}` : "";
  return `${host}/l/${encodeURIComponent(generalPermalink(product) ?? "")}${query}`;
}
