import { describe, expect, it } from "vitest";

import { canPingSales } from "./ping-notification.ts";
import { setSqlClient } from "./sql.ts";

type Tables = {
  resource_subscriptions?: { post_url: string | null; oauth_application_id: number }[];
  oauth_applications?: { id: number }[];
  oauth_access_tokens?: { application_id: number; scopes: string | null }[];
};

function answering(tables: Tables) {
  const statements: string[] = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      statements.push(query.sql);
      if (query.sql.includes("FROM `resource_subscriptions`")) return tables.resource_subscriptions ?? [];
      if (query.sql.includes("FROM `oauth_applications`")) return tables.oauth_applications ?? [];
      if (query.sql.includes("FROM `oauth_access_tokens`")) return tables.oauth_access_tokens ?? [];
      throw new Error(`unexpected statement: ${query.sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
  return statements;
}

const seller = (notification_endpoint: string | null = null) => ({ id: 7, notification_endpoint });
const subscription = { post_url: "https://hooks.example.com/ping", oauth_application_id: 3 };

describe("canPingSales", () => {
  it("is true for a seller with a notification endpoint, without asking the database", async () => {
    const statements = answering({});

    expect(await canPingSales(seller("https://example.com/ping"))).toBe(true);
    expect(statements).toEqual([]);
  });

  it("treats a blank endpoint as none", async () => {
    answering({});

    expect(await canPingSales(seller("  "))).toBe(false);
  });

  it("is false for a seller with no subscriptions", async () => {
    answering({});

    expect(await canPingSales(seller())).toBe(false);
  });

  it("is true for a subscription whose application is alive and holds a view_sales token", async () => {
    answering({
      resource_subscriptions: [subscription],
      oauth_applications: [{ id: 3 }],
      oauth_access_tokens: [{ application_id: 3, scopes: "view_sales" }],
    });

    expect(await canPingSales(seller())).toBe(true);
  });

  it("accepts the account scope among several", async () => {
    answering({
      resource_subscriptions: [subscription],
      oauth_applications: [{ id: 3 }],
      oauth_access_tokens: [{ application_id: 3, scopes: "edit_products account" }],
    });

    expect(await canPingSales(seller())).toBe(true);
  });

  it("is false when the only token lacks both scopes, or none is live", async () => {
    answering({
      resource_subscriptions: [subscription],
      oauth_applications: [{ id: 3 }],
      oauth_access_tokens: [{ application_id: 3, scopes: "edit_products" }],
    });
    expect(await canPingSales(seller())).toBe(false);

    answering({ resource_subscriptions: [subscription], oauth_applications: [{ id: 3 }], oauth_access_tokens: [] });
    expect(await canPingSales(seller())).toBe(false);
  });

  it("is false when the application is deleted or the subscription has no URL", async () => {
    answering({
      resource_subscriptions: [subscription],
      oauth_applications: [],
      oauth_access_tokens: [{ application_id: 3, scopes: "view_sales" }],
    });
    expect(await canPingSales(seller())).toBe(false);

    answering({
      resource_subscriptions: [{ post_url: " ", oauth_application_id: 3 }],
      oauth_applications: [{ id: 3 }],
      oauth_access_tokens: [{ application_id: 3, scopes: "view_sales" }],
    });
    expect(await canPingSales(seller())).toBe(false);
  });

  it("needs the token to belong to the subscription's own application", async () => {
    answering({
      resource_subscriptions: [subscription],
      oauth_applications: [{ id: 3 }],
      oauth_access_tokens: [{ application_id: 4, scopes: "view_sales" }],
    });

    expect(await canPingSales(seller())).toBe(false);
  });
});
