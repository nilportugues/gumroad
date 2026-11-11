import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError, type ActionContext } from "./application-controller.ts";
import { railsRequest } from "./rails-request.ts";

const { db, grantsAccess } = vi.hoisted(() => ({
  db: {
    purchase: { findUnique: vi.fn() },
    subscription: { findUnique: vi.fn() },
    link: { findUnique: vi.fn() },
    urlRedirect: { count: vi.fn() },
    purchaseIntegration: { findMany: vi.fn() },
    integration: { count: vi.fn() },
    user: { findUnique: vi.fn() },
    customDomain: { findFirst: vi.fn() },
  },
  grantsAccess: vi.fn(),
}));

vi.mock("../../lib/db.ts", () => ({ db }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));
vi.mock("../models/user.ts", () => ({
  subdomainFromUsername: (name: string | null) => (name ? `${name}.example.com` : null),
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({ protocol: "https" }) }));
vi.mock("./url-redirects/access.ts", () => ({ grantsAccess }));

const { discordHandlers } = await import("./discord.ts");

const NOW = new Date("2026-01-01T00:00:00Z");
// Purchase flags 25 (is_access_revoked) and 10 (chargeback_reversed)
const ACCESS_REVOKED = 1n << 24n;
const CHARGEBACK_REVERSED = 1n << 9n;
const request = (query: string) => railsRequest(new Request(`https://app.example.com/integrations/discord/x${query}`));
const action = (loggedInUserId: bigint | null) =>
  ({
    context: { loggedInUser: loggedInUserId === null ? null : { id: loggedInUserId } },
    chain: { now: NOW },
  }) as unknown as ActionContext;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as unknown;
const purchaseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  purchaser_id: 3n,
  link_id: 9n,
  subscription_id: null,
  stripe_refunded: false,
  chargeback_date: null,
  flags: 0n,
  ...overrides,
});
const stateQuery = (state: unknown, extra = "") => `?${extra}state=${encodeURIComponent(JSON.stringify(state))}`;

beforeEach(() => {
  vi.resetAllMocks();
  db.purchase.findUnique.mockResolvedValue(purchaseRow());
});

describe("GET /integrations/discord/join_server", () => {
  const join = (query: string, user: bigint | null = 3n) =>
    discordHandlers.discord_join_server(request(query), action(user));

  it("reports failure without a code", async () => {
    expect(body(await join("?purchase_id=7"))).toEqual({ success: false });
    expect(db.purchase.findUnique).not.toHaveBeenCalled();
  });

  it("reports failure for a blank purchase id", async () => {
    expect(body(await join("?code=abc&purchase_id=%20"))).toEqual({ success: false });
  });

  it("reports failure for a purchase that does not exist", async () => {
    db.purchase.findUnique.mockResolvedValue(null);
    expect(body(await join("?code=abc&purchase_id=7"))).toEqual({ success: false });
  });

  it("reports failure for a purchase id that does not decrypt", async () => {
    expect(body(await join("?code=abc&purchase_id=nope"))).toEqual({ success: false });
    expect(db.purchase.findUnique).not.toHaveBeenCalled();
  });

  it("reports failure for a signed-in user who is not the purchaser", async () => {
    db.urlRedirect.count.mockResolvedValue(0);
    expect(body(await join("?code=abc&purchase_id=7", 4n))).toEqual({ success: false });
  });

  it("reports failure for a signed-out visitor without a token", async () => {
    expect(body(await join("?code=abc&purchase_id=7", null))).toEqual({ success: false });
    expect(db.urlRedirect.count).not.toHaveBeenCalled();
  });

  it("reports failure for a token that no redirect of the purchase carries", async () => {
    db.urlRedirect.count.mockResolvedValue(0);
    expect(body(await join("?code=abc&purchase_id=7&token=other", null))).toEqual({ success: false });
    expect(db.urlRedirect.count).toHaveBeenCalledWith({ where: { token: "other", purchase_id: 7n } });
  });

  it.each([
    ["a refunded purchase", { stripe_refunded: true }],
    ["a charged back purchase", { chargeback_date: NOW }],
    ["a purchase whose access was revoked", { flags: ACCESS_REVOKED }],
  ])("reports failure for %s", async (_name, overrides) => {
    db.purchase.findUnique.mockResolvedValue(purchaseRow(overrides));
    expect(body(await join("?code=abc&purchase_id=7"))).toEqual({ success: false });
  });

  it("keeps a charged back purchase whose chargeback was reversed", async () => {
    db.purchase.findUnique.mockResolvedValue(purchaseRow({ chargeback_date: NOW, flags: CHARGEBACK_REVERSED }));
    await expect(join("?code=abc&purchase_id=7")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("reports failure for a lapsed membership", async () => {
    db.purchase.findUnique.mockResolvedValue(purchaseRow({ subscription_id: 5n }));
    db.subscription.findUnique.mockResolvedValue({ id: 5n });
    db.link.findUnique.mockResolvedValue({ id: 9n });
    grantsAccess.mockReturnValue(false);
    expect(body(await join("?code=abc&purchase_id=7"))).toEqual({ success: false });
    expect(grantsAccess).toHaveBeenCalledWith({ id: 5n }, { id: 9n }, NOW);
  });

  it("hands a purchaser's request to Rails", async () => {
    await expect(join("?code=abc&purchase_id=7")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a token holder's request to Rails", async () => {
    db.urlRedirect.count.mockResolvedValue(1);
    await expect(join("?code=abc&purchase_id=7&token=t", null)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a membership that still grants access to Rails", async () => {
    db.purchase.findUnique.mockResolvedValue(purchaseRow({ subscription_id: 5n }));
    db.subscription.findUnique.mockResolvedValue({ id: 5n });
    grantsAccess.mockReturnValue(true);
    await expect(join("?code=abc&purchase_id=7")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a parameter sent as a hash to Rails", async () => {
    await expect(join("?code=abc&purchase_id=7&token[x]=y")).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("GET /integrations/discord/leave_server", () => {
  const leave = (query: string, user: bigint | null = 3n) =>
    discordHandlers.discord_leave_server(request(query), action(user));

  it("reports failure without a purchase id", async () => {
    expect(body(await leave(""))).toEqual({ success: false });
  });

  it("reports failure for a signed-out visitor without a token", async () => {
    expect(body(await leave("?purchase_id=7", null))).toEqual({ success: false });
  });

  it("reports failure for a purchase with no live membership", async () => {
    db.purchaseIntegration.findMany.mockResolvedValue([]);
    expect(body(await leave("?purchase_id=7"))).toEqual({ success: false });
    expect(db.purchaseIntegration.findMany).toHaveBeenCalledWith({
      where: { purchase_id: 7n, deleted_at: null },
      select: { integration_id: true },
    });
  });

  it("reports failure for a purchase whose memberships are not Discord's", async () => {
    db.purchaseIntegration.findMany.mockResolvedValue([{ integration_id: 2n }]);
    db.integration.count.mockResolvedValue(0);
    expect(body(await leave("?purchase_id=7"))).toEqual({ success: false });
    expect(db.integration.count).toHaveBeenCalledWith({ where: { id: { in: [2n] }, type: "DiscordIntegration" } });
  });

  it("hands a purchaser with a Discord membership to Rails", async () => {
    db.purchaseIntegration.findMany.mockResolvedValue([{ integration_id: 2n }]);
    db.integration.count.mockResolvedValue(1);
    await expect(leave("?purchase_id=7")).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("GET /integrations/discord/oauth_redirect", () => {
  const redirect = (query: string) => discordHandlers.discord_oauth_redirect(request(query));

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ id: 11n, username: "gum_seller" });
  });

  it("redirects to the seller's subdomain with the code escaped", async () => {
    expect(await redirect(stateQuery({ seller_id: "11" }, "code=a%20b%26c&"))).toEqual({
      status: 302,
      location: "https://gum_seller.example.com/integrations/discord/oauth_redirect?code=a+b%26c",
    });
  });

  it("takes the port from the request, not from the host", async () => {
    db.customDomain.findFirst.mockResolvedValue({ domain: "www.shop.example.net:9999" });
    const state = stateQuery({ seller_id: "11", is_custom_domain: true });
    const result = await discordHandlers.discord_oauth_redirect(
      railsRequest(new Request(`https://app.example.com:31337/x${state}`)),
    );
    expect(result).toMatchObject({
      location: "https://www.shop.example.net:31337/integrations/discord/oauth_redirect",
    });
  });

  it("redirects without a code when the request has none", async () => {
    expect(await redirect(stateQuery({ seller_id: "11" }))).toMatchObject({
      location: "https://gum_seller.example.com/integrations/discord/oauth_redirect",
    });
  });

  it("keeps an empty code", async () => {
    expect(await redirect(stateQuery({ seller_id: "11" }, "code=&"))).toMatchObject({
      location: expect.stringMatching(/\?code=$/u),
    });
  });

  it("redirects to the custom domain for any state value Ruby treats as true", async () => {
    db.customDomain.findFirst.mockResolvedValue({ domain: "www.shop.example.net" });
    expect(await redirect(stateQuery({ seller_id: "11", is_custom_domain: 0 }, "code=x&"))).toMatchObject({
      location: "https://www.shop.example.net/integrations/discord/oauth_redirect?code=x",
    });
    expect(db.customDomain.findFirst).toHaveBeenCalledWith({
      where: { user_id: 11, deleted_at: null },
      orderBy: { id: "asc" },
    });
  });

  it("uses the subdomain when is_custom_domain is false or null", async () => {
    for (const flag of [false, null]) {
      expect(await redirect(stateQuery({ seller_id: "11", is_custom_domain: flag }))).toMatchObject({
        location: expect.stringContaining("gum_seller.example.com"),
      });
    }
    expect(db.customDomain.findFirst).not.toHaveBeenCalled();
  });

  it("answers a seller id that does not decrypt with a 404", async () => {
    await expect(redirect(stateQuery({ seller_id: "not-an-id" }))).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers a seller that does not exist with a 404", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(redirect(stateQuery({ seller_id: "11" }))).rejects.toBeInstanceOf(RoutingError);
  });

  it.each([
    ["no parameters", ""],
    ["a code alone", "?code=x"],
    ["a state that is not JSON", "?state=test"],
    ["a state that is not an object", "?state=123"],
    ["a state that is a list", `?state=${encodeURIComponent("[]")}`],
    ["a state without a seller id", stateQuery({ is_custom_domain: false })],
    ["a blank seller id", stateQuery({ seller_id: "  " })],
    ["a seller id that is not text", stateQuery({ seller_id: 12 })],
    ["a state sent as a list", "?state[]=test"],
  ])("hands %s to Rails", async (_name, query) => {
    await expect(redirect(query)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a seller with no username to Rails", async () => {
    db.user.findUnique.mockResolvedValue({ id: 11n, username: null });
    await expect(redirect(stateQuery({ seller_id: "11" }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a seller with no custom domain to Rails", async () => {
    db.customDomain.findFirst.mockResolvedValue(null);
    await expect(redirect(stateQuery({ seller_id: "11", is_custom_domain: true }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});
