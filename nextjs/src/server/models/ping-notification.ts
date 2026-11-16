// User::PingNotification#urls_for_ping_notification(ResourceSubscription::SALE_RESOURCE_NAME).size > 0, which is all the sales
// surfaces read of it (`can_ping`).
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "./sql.ts";

const SALE_RESOURCE_NAME = "sale";
// The scopes that let a token deliver a seller's sale pings (User::PingNotification#live_ping_notification_token?).
const PING_SCOPES = ["view_sales", "account"];

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

type Subscription = { post_url: string | null; oauth_application_id: bigint | number };

export async function canPingSales(seller: {
  id: bigint | number;
  notification_endpoint: string | null;
}): Promise<boolean> {
  // The seller's own endpoint is always a target for a sale ping.
  if (present(seller.notification_endpoint)) return true;

  const subscriptions = await selectRows<Subscription>(
    Prisma.sql`SELECT ${column("resource_subscriptions", "post_url")}, ${column("resource_subscriptions", "oauth_application_id")} FROM ${table("resource_subscriptions")} WHERE ${column("resource_subscriptions", "user_id")} = ${seller.id} AND ${column("resource_subscriptions", "deleted_at")} IS NULL AND ${column("resource_subscriptions", "resource_name")} = ${SALE_RESOURCE_NAME}`,
  );
  const candidates = subscriptions.filter((subscription) => present(subscription.post_url));
  if (candidates.length === 0) return false;

  const applicationIds = [...new Set(candidates.map((subscription) => BigInt(subscription.oauth_application_id)))];
  const [applications, tokens] = await Promise.all([
    selectRows<{ id: bigint | number }>(
      Prisma.sql`SELECT ${column("oauth_applications", "id")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} IN (${Prisma.join(applicationIds)}) AND ${column("oauth_applications", "deleted_at")} IS NULL`,
    ),
    // Doorkeeper::AccessToken.active_for(seller): the seller's tokens that were not revoked.
    selectRows<{ application_id: bigint | number; scopes: string | null }>(
      Prisma.sql`SELECT ${column("oauth_access_tokens", "application_id")}, ${column("oauth_access_tokens", "scopes")} FROM ${table("oauth_access_tokens")} WHERE ${column("oauth_access_tokens", "resource_owner_id")} = ${seller.id} AND ${column("oauth_access_tokens", "revoked_at")} IS NULL AND ${column("oauth_access_tokens", "application_id")} IN (${Prisma.join(applicationIds)})`,
    ),
  ]);
  const alive = new Set(applications.map((application) => BigInt(application.id)));
  const delivering = new Set(
    tokens
      .filter((token) => (token.scopes ?? "").split(/\s+/u).some((scope) => PING_SCOPES.includes(scope)))
      .map((token) => BigInt(token.application_id)),
  );
  return candidates.some(
    (subscription) =>
      alive.has(BigInt(subscription.oauth_application_id)) && delivering.has(BigInt(subscription.oauth_application_id)),
  );
}
