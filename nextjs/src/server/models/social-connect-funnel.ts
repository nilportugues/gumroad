// SocialConnectFunnel.record! and .record_offers! (app/services/social_connect_funnel.rb): Event rows that measure the
// optional social connect. record! rescues every StandardError and logs it, so a failed write never reaches the page.
// Golden: __fixtures__/social-connect-funnel.golden.json (scripts/golden/social-connect-funnel.rb).
import { Prisma } from "@prisma/client";

import { Events } from "./event.ts";
import { column, selectRows, table } from "./sql.ts";

export const SOCIAL_CONNECT_STAGES = ["offered", "attempted", "connected", "failed", "reviewed", "hold_released"] as const;
export const SOCIAL_CONNECT_PROVIDERS = ["twitter", "youtube", "instagram", "tiktok", "none"] as const;
export const SOCIAL_CONNECT_SURFACES = [
  "getting_started",
  "account_review",
  "profile",
  "omniauth",
  "admin_social_connections",
  "mark_compliant",
  "payouts_resume",
] as const;
const CONNECTION_NAME_TO_PROVIDER: Record<string, string> = { X: "twitter", YouTube: "youtube", Instagram: "instagram", TikTok: "tiktok" };

export type SocialConnection = { name: string; connected: boolean; provider?: string };

const eventName = (stage: string) => `social_connect_${stage}`;

type RecordOptions = { userId: bigint; stage: string; provider: string; surface: string; once?: boolean; now: () => Date };

// SocialConnectFunnel.record!, for a user that is present.
export async function recordSocialConnectEvent({ userId, stage, provider, surface, once = false, now }: RecordOptions): Promise<void> {
  if (!(SOCIAL_CONNECT_STAGES as readonly string[]).includes(stage)) return;
  if (!(SOCIAL_CONNECT_PROVIDERS as readonly string[]).includes(provider)) return;
  if (!(SOCIAL_CONNECT_SURFACES as readonly string[]).includes(surface)) return;
  const name = eventName(stage);
  try {
    if (once) {
      const [existing] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("events")} WHERE ${column("events", "user_id")} = ${userId} AND ${column("events", "event_name")} = ${name} AND ${column("events", "parent_referrer")} = ${provider} AND ${column("events", "view_url")} = ${surface} LIMIT 1`,
      );
      if (existing) return;
    }
    await Events.createBang({ event_name: name, user_id: Number(userId), parent_referrer: provider, view_url: surface, referrer: null } as never, { now });
  } catch (error) {
    console.error(`SocialConnectFunnel ${stage}/${provider} failed for user ${String(userId)}: ${(error as Error).name}: ${(error as Error).message}`);
  }
}

// SocialConnectFunnel.record_offers!: one `offered` event per provider the seller has not connected, once per provider and surface.
export async function recordOffers({
  userId,
  connections,
  surface,
  skip = false,
  now,
}: {
  userId: bigint;
  connections: SocialConnection[] | undefined;
  surface: string;
  skip?: boolean;
  now: () => Date;
}): Promise<void> {
  if (skip || !connections || connections.length === 0) return;
  for (const connection of connections) {
    if (connection.connected) continue;
    const provider = connection.provider ? connection.provider : CONNECTION_NAME_TO_PROVIDER[connection.name];
    if (!provider) continue;
    await recordSocialConnectEvent({ userId, stage: "offered", provider, surface, once: true, now });
  }
}
