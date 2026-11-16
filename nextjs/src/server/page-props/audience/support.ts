// Small ports the audience presenters share: external ids, the URL builders models use, and the
// way Rack reads a request's parameters.
import type { User } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
// Anything with a raw query string: a RailsRequest, or `{ queryString: url.search.slice(1) }` for a page URL.
export type QuerySource = { queryString: string };

import { Users, subdomainWithProtocol, username } from "../../models/user.ts";
import { domainConfig } from "../domain.ts";

// ExternalId#external_id
export const externalId = (id: number | bigint): string => encrypt(id);

// Object#present? for a nullable string column.
export const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);

export const protocol = (): string => domainConfig(process.env).protocol;

// UrlService.short_domain_with_protocol
export const shortDomainWithProtocol = (): string => `${protocol()}://${domainConfig(process.env).shortDomain}`;

// UrlService.domain_with_protocol
export const domainWithProtocol = (): string => `${protocol()}://${domainConfig(process.env).domain}`;

// User#subdomain_with_protocol
export const userSubdomainWithProtocol = (user: User): string | null => subdomainWithProtocol(Users.load(user));

// User#username: the external id stands in for a seller without one.
export const userUsername = (user: User): string | null => username(Users.load(user));

// User#profile_url: the seller's subdomain.
export function profileUrl(user: User): string {
  const subdomain = userSubdomainWithProtocol(user);
  if (subdomain === null) throw new Error("bad argument (expected URI object or URI string)");
  return subdomain;
}

// Addressable::URI.encode_component(value, CharacterClasses::UNRESERVED)
const UNRESERVED = /[A-Za-z0-9\-._~]/u;
function encodeComponent(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) =>
      UNRESERVED.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
}

// Addressable::URI.unencode_component: only well-formed %XX escapes are decoded, anything else stays as written.
function unencodeComponent(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; ) {
    if (value[index] === "%" && /^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 3;
    } else {
      bytes.push(...Buffer.from(String.fromCodePoint(value.codePointAt(index)!), "utf8"));
      index += value.codePointAt(index)! > 0xffff ? 2 : 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Addressable::URI#query_values= followed by #to_s: the URL's own query values (`+` read as a space, a bare `key` as nil) merged
// with the new ones, sorted by key bytes, a nil value written as the bare key.
export function withQueryValues(url: string, values: Record<string, string>): string {
  const hashIndex = url.indexOf("#");
  const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutFragment = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const base = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const merged = new Map<string, string | null>();
  if (queryIndex !== -1) {
    for (const pair of withoutFragment.slice(queryIndex + 1).split("&")) {
      if (pair === "") continue;
      const equals = pair.indexOf("=");
      const key = unencodeComponent(equals === -1 ? pair : pair.slice(0, equals));
      merged.set(key, equals === -1 ? null : unencodeComponent(pair.slice(equals + 1).replaceAll("+", " ")));
    }
  }
  for (const [key, value] of Object.entries(values)) merged.set(key, value);
  const query = [...merged.entries()]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
    .map(([key, value]) =>
      value === null ? encodeComponent(key) : `${encodeComponent(key)}=${encodeComponent(value)}`,
    )
    .join("&");
  return `${base}?${query}${fragment}`;
}

// Rack's nested query parser for the shapes the audience pages read: `name=value` and
// `name[]=value`. The last scalar wins; arrays collect.
export function rackParam(request: QuerySource, name: string): string | string[] | undefined {
  let scalar: string | undefined;
  const list: string[] = [];
  for (const pair of request.queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decodeQuery(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? "" : decodeQuery(pair.slice(index + 1));
    if (key === name) scalar = value;
    else if (key === `${name}[]`) list.push(value);
  }
  return list.length > 0 ? list : scalar;
}

function decodeQuery(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

// `params[name].to_s`
export const stringParam = (request: QuerySource, name: string): string => {
  const value = rackParam(request, name);
  return typeof value === "string" ? value : "";
};

// Ruby's String#to_i on a request parameter.
export function paramToI(value: string): number {
  const match = /^\s*([+-]?\d[\d_]*)/u.exec(value);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}
