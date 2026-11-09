import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError, type Chain } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn() },
    baseVariantsPurchase: { count: vi.fn() },
    productFile: { count: vi.fn() },
    productIntegration: { count: vi.fn() },
    thirdPartyAnalytic: { count: vi.fn() },
    installment: { count: vi.fn() },
    purchase: { findMany: vi.fn() },
    gift: { count: vi.fn() },
    link: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
  load: vi.fn(),
  hasRichContent: vi.fn(),
  createEventBang: vi.fn(),
}));

vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("./unavailable.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), load: mocks.load, hasRichContent: mocks.hasRichContent, layoutProps: () => ({ token: "tok123" }) }));
vi.mock("../../models/consumption-event.ts", () => ({ createEventBang: mocks.createEventBang }));
vi.mock("../../auth/rails-session-config.ts", async () => {
  const { deriveRailsCookieSecrets } = await import("../../auth/rails-cookies.ts");
  return { railsCookieSecrets: () => deriveRailsCookieSecrets("test-secret-key-base") };
});

const { downloadPageFilters } = await import("./download-page.ts");

const NOW = new Date("2026-03-01T12:00:00Z");

const loaded = (overrides: Record<string, unknown> = {}) => ({
  redirect: { id: 11n, token: "tok123", purchase_id: 5n, link_id: 3n, flags: 0n },
  purchase: { id: 5n, link_id: 3n, purchaser_id: null, flags: 0n, stripe_refunded: null, chargeback_date: null, rental_expired: null, ip_address: null, json_data: null },
  product: { id: 3n, user_id: 2n, flags: 0n, native_type: "digital" },
  seller: null,
  purchaser: null,
  subscription: null,
  ...overrides,
});

function chain(overrides: { path?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  return {
    request: {
      method: "GET",
      path: overrides.path ?? "/d/tok123",
      queryString: "",
      headers: new Headers({ accept: "text/html", ...overrides.headers }),
      cookies: new Map(Object.entries(overrides.cookies ?? {})),
    },
    now: NOW,
    headers: new Headers(),
    auth: { context: { loggedInUser: null, currentSeller: null, impersonatedUser: null }, effects: {} },
    afterCookies: [] as string[],
  } as unknown as Chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(loaded());
  mocks.hasRichContent.mockResolvedValue(false);
  mocks.db.user.findUnique.mockResolvedValue({ id: 2n, google_analytics_id: null, facebook_pixel_id: null, json_data: null });
  for (const model of [mocks.db.baseVariantsPurchase, mocks.db.productFile, mocks.db.productIntegration, mocks.db.thirdPartyAnalytic, mocks.db.installment]) model.count.mockResolvedValue(0);
});

describe("downloadPageFilters", () => {
  it("records the visit: a view event, the use count, the seen flag and the confirmed cookie", async () => {
    const request = chain();
    await expect(downloadPageFilters(request)).resolves.toEqual({ state: {} });

    expect(mocks.createEventBang).toHaveBeenCalledWith(expect.objectContaining({ event_type: "view", platform: "web", url_redirect_id: 11n, purchase_id: 5n, product_id: 3n, product_file_id: null }));
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(String(mocks.db.$executeRaw.mock.calls[0]![0].sql)).toContain("uses = COALESCE(uses, 0) + 1");
    expect(String(mocks.db.$executeRaw.mock.calls[1]![0].sql)).toContain("flags = COALESCE(flags, 0) |");
    expect(request.afterCookies).toHaveLength(1);
    expect(request.afterCookies[0]).toMatch(/^confirmed_redirect=.+; path=\/; httponly; samesite=lax$/);
    expect(request.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("writes nothing when the access check redirects", async () => {
    mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, flags: 1n << 24n } }));
    const request = chain();
    await expect(downloadPageFilters(request)).resolves.toEqual({ halt: { status: 302, location: "/r/tok123/expired", rescued: true } });

    expect(mocks.createEventBang).not.toHaveBeenCalled();
    expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    expect(request.afterCookies).toEqual([]);
  });

  it("answers 404 for a refunded purchase", async () => {
    mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, stripe_refunded: true } }));
    await expect(downloadPageFilters(chain())).rejects.toBeInstanceOf(RoutingError);
  });

  it("asks for the purchase email once the link was opened", async () => {
    mocks.load.mockResolvedValue(loaded({ redirect: { ...loaded().redirect, flags: 1n } }));
    await expect(downloadPageFilters(chain())).resolves.toEqual({ halt: { status: 302, location: "/confirm?destination=download_page&id=tok123", rescued: true } });
  });

  describe("shapes Rails renders", () => {
    it.each([
      ["product files", () => mocks.db.productFile.count.mockResolvedValue(1)],
      ["integrations", () => mocks.db.productIntegration.count.mockResolvedValue(1)],
      ["third-party analytics", () => mocks.db.thirdPartyAnalytic.count.mockResolvedValue(1)],
      ["posts", () => mocks.db.installment.count.mockResolvedValue(1)],
      ["a purchased variant", () => mocks.db.baseVariantsPurchase.count.mockResolvedValue(1)],
      ["rich content", () => mocks.hasRichContent.mockResolvedValue(true)],
      ["a license key", () => mocks.load.mockResolvedValue(loaded({ product: { ...loaded().product, flags: 1n << 6n } }))],
      ["a coffee product", () => mocks.load.mockResolvedValue(loaded({ product: { ...loaded().product, native_type: "coffee" } }))],
      ["a bundle purchase", () => mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, flags: 1n << 25n } }))],
      ["a saved content page", () => mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, json_data: "---\nlast_content_page_id: abc\n" } }))],
    ])("hand back %s without recording the visit", async (_, arrange) => {
      arrange();
      await expect(downloadPageFilters(chain())).rejects.toBeInstanceOf(HandBackToRails);

      expect(mocks.createEventBang).not.toHaveBeenCalled();
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    });

    it("hands back a poll that passes the access check, and the mobile app token sign-in", async () => {
      const poll = { "x-inertia": "true", "x-inertia-partial-component": "UrlRedirects/DownloadPage", "x-inertia-partial-data": "audio_durations" };
      await expect(downloadPageFilters(chain({ headers: poll }))).rejects.toBeInstanceOf(HandBackToRails);

      const withToken = chain();
      withToken.request.queryString = "access_token=abc";
      await expect(downloadPageFilters(withToken)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
