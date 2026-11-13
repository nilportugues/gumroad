// Api::V2::ResourceSubscriptionsController (app/controllers/api/v2/resource_subscriptions_controller.rb): #index and #destroy, and the 404 of
// #test_event. #create resolves the post URL's host through DNS (SsrfFilter's reserved ranges) and #test_event delivers an HTTP request, so
// Rails takes both whole, except a post URL that never reaches DNS: one that is not a URI, or whose host is a reserved IPv4 literal.
import { Prisma, type ResourceSubscription } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { castRow, column, execute, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails } from "../application-controller.ts";

import { errorWithObject, fromExternalId, registerApiV2, renderResponse, successWithObject } from "./base.ts";

const RESOURCE_SUBSCRIPTIONS = "resource_subscriptions";
// ResourceSubscription::VALID_RESOURCE_NAMES
const VALID_RESOURCE_NAMES = [
  "sale",
  "cancellation",
  "subscription_ended",
  "subscription_restarted",
  "subscription_updated",
  "refund",
  "dispute",
  "dispute_won",
];
// ActiveModel::Type::Boolean::FALSE_VALUES
const FALSE_VALUES = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
const castBoolean = (value: unknown) =>
  value === null || value === undefined || value === "" ? null : !FALSE_VALUES.has(value as never);

// SsrfFilter::IPV4_BLACKLIST as [network, prefix length]
const RESERVED_IPV4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];
const DECIMAL_OCTET = "(?:0|[1-9]\\d{0,2})";
// An http(s) URL whose authority is a dotted-quad literal (no userinfo, no zero-padded or short forms: Resolv reads those as host names)
const IPV4_LITERAL_URL = new RegExp(
  `^https?://(${DECIMAL_OCTET}(?:\\.${DECIMAL_OCTET}){3})(?::\\d*)?(?:[/?#]|$)`,
  "iu",
);
const ipv4ToInt = (octets: number[]) => octets.reduce((acc, octet) => acc * 256 + octet, 0);
const isReservedIpv4 = (octets: number[]) => {
  const ip = ipv4ToInt(octets);
  return RESERVED_IPV4_RANGES.some(([network, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = ipv4ToInt(network.split(".").map(Number));
    return ip >= start && ip < start + size;
  });
};
// URI.parse raises on any character outside printable ASCII (space, control characters, non-ASCII), whatever else the string holds.
const NOT_A_URI = /[^\u0021-\u007e]/u;

// ResourceSubscription.valid_post_url? is false for these without a lookup. Anything else needs DNS or a URI parser Node does not mirror.
function postUrlRefusedWithoutDns(postUrl: unknown): boolean {
  if (typeof postUrl !== "string") return false;
  if (NOT_A_URI.test(postUrl)) return true;
  const literal = IPV4_LITERAL_URL.exec(postUrl)?.[1];
  if (literal === undefined) return false;
  const octets = literal.split(".").map(Number);
  return octets.every((octet) => octet <= 255) && isReservedIpv4(octets);
}

const json = (row: ResourceSubscription) => ({
  id: encrypt(row.id),
  resource_name: row.resource_name,
  post_url: row.post_url,
});

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/resource_subscriptions",
    scopes: ["view_sales"],
    async run({ owner, params, token }) {
      const resourceName = params.resource_name;
      if (typeof resourceName !== "string" || !VALID_RESOURCE_NAMES.includes(resourceName))
        return renderResponse(false, { message: "Valid resource_name parameter required" });

      const conditions = [
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "user_id")} = ${owner.id}`,
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "deleted_at")} IS NULL`,
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "resource_name")} = ${resourceName}`,
      ];
      if (castBoolean(params.current_oauth_application_only))
        conditions.push(
          Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "oauth_application_id")} = ${token.application_id}`,
        );
      const rows = await selectRows(
        Prisma.sql`SELECT ${table(RESOURCE_SUBSCRIPTIONS)}.* FROM ${table(RESOURCE_SUBSCRIPTIONS)} WHERE ${Prisma.join(conditions, " AND ")} ORDER BY ${column(RESOURCE_SUBSCRIPTIONS, "id")}`,
      );
      return successWithObject(
        "resource_subscriptions",
        rows.map((row) => json(castRow<ResourceSubscription>("ResourceSubscription", row))),
      );
    },
  },
  {
    method: "DELETE",
    pattern: "/v2/resource_subscriptions/:id",
    scopes: ["view_sales"],
    async run({ routeParams, token }) {
      const id = fromExternalId(routeParams.id);
      const found = id === null ? null : await db.resourceSubscription.findUnique({ where: { id } });
      if (found === null || token.application_id !== found.oauth_application_id)
        return errorWithObject("resource_subscription");
      // Deletable#mark_deleted!: Time.current, cast to the column's precision (seconds)
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      await execute(
        Prisma.sql`UPDATE ${table(RESOURCE_SUBSCRIPTIONS)} SET ${column(RESOURCE_SUBSCRIPTIONS, "deleted_at")} = ${now}, ${column(RESOURCE_SUBSCRIPTIONS, "updated_at")} = ${now} WHERE ${column(RESOURCE_SUBSCRIPTIONS, "id")} = ${found.id}`,
      );
      return successWithObject("resource_subscription", null);
    },
  },
  {
    method: "PUT",
    pattern: "/v2/resource_subscriptions",
    scopes: ["view_sales"],
    async run({ params }) {
      // Checked before resource_name, as in #create
      if (postUrlRefusedWithoutDns(params.post_url))
        return renderResponse(false, { message: `Invalid post URL '${String(params.post_url)}'` });
      throw new HandBackToRails("a resource subscription whose post URL is resolved through DNS");
    },
  },
  {
    method: "POST",
    pattern: "/v2/resource_subscriptions/:id/test_event",
    scopes: ["view_sales"],
    async run({ owner, routeParams, token }) {
      const id = fromExternalId(routeParams.id);
      const found =
        id === null
          ? null
          : await db.resourceSubscription.findFirst({
              where: {
                id,
                user_id: Number(owner.id),
                deleted_at: null,
                oauth_application_id: Number(token.application_id),
              },
            });
      if (found === null) return errorWithObject("resource_subscription");
      throw new HandBackToRails("a test event delivered to the subscription's post URL");
    },
  },
);
