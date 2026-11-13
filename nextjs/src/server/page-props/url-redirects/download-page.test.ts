import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails, RoutingError, type Chain } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "download-page-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";
  return {
    db: {
      user: { findUnique: vi.fn() },
      baseVariantsPurchase: { findMany: vi.fn() },
      baseVariant: { findMany: vi.fn() },
      variantCategory: { findMany: vi.fn() },
      baseVariantsProductFile: { findMany: vi.fn() },
      productFile: { count: vi.fn() },
      productIntegration: { count: vi.fn() },
      thirdPartyAnalytic: { count: vi.fn() },
      richContent: { findMany: vi.fn() },
      license: { findMany: vi.fn() },
      purchase: { findMany: vi.fn() },
      gift: { count: vi.fn() },
      link: { findUnique: vi.fn() },
      $executeRaw: vi.fn(),
    },
    load: vi.fn(),
    createEventBang: vi.fn(),
    contentItems: vi.fn(),
    downloadPosts: vi.fn(),
    aliveProductFiles: vi.fn(),
    contentProvider: vi.fn(),
    latestMediaLocations: vi.fn(),
  };
});

vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));
vi.mock("./unavailable.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  load: mocks.load,
  layoutProps: () => ({ token: "tok123" }),
}));
// The files a content page lists are covered by the recorded url_redirect_player_pages_spec examples.
vi.mock("./download-files.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  contentItems: mocks.contentItems,
}));
vi.mock("./download-posts.ts", () => ({ downloadPosts: mocks.downloadPosts }));
vi.mock("../../controllers/url-redirects/files.ts", () => ({
  aliveProductFiles: mocks.aliveProductFiles,
  contentProvider: mocks.contentProvider,
}));
vi.mock("../storefront/post.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setFaviconMetaTags: vi.fn(),
}));
vi.mock("./media-locations.ts", () => ({ latestMediaLocations: mocks.latestMediaLocations }));
vi.mock("../../models/consumption-event.ts", () => ({ createEventBang: mocks.createEventBang }));
vi.mock("../../auth/rails-session-config.ts", async () => {
  const { deriveRailsCookieSecrets } = await import("../../auth/rails-cookies.ts");
  return { railsCookieSecrets: () => deriveRailsCookieSecrets("test-secret-key-base") };
});

const { downloadPageFilters, downloadPageProps, lastContentPageId, POLL_STATE_KEY, setDownloadPageMeta } = await import(
  "./download-page.ts"
);

const NOW = new Date("2026-03-01T12:00:00Z");

const loaded = (overrides: Record<string, unknown> = {}) => ({
  redirect: { id: 11n, token: "tok123", purchase_id: 5n, link_id: 3n, flags: 0n },
  purchase: {
    id: 5n,
    link_id: 3n,
    purchaser_id: null,
    flags: 0n,
    stripe_refunded: null,
    chargeback_date: null,
    rental_expired: null,
    ip_address: null,
    json_data: null,
  },
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
  mocks.contentItems.mockResolvedValue([]);
  mocks.contentProvider.mockResolvedValue({ kind: "product" });
  mocks.downloadPosts.mockResolvedValue([]);
  mocks.db.richContent.findMany.mockResolvedValue([]);
  mocks.db.license.findMany.mockResolvedValue([]);
  mocks.db.user.findUnique.mockResolvedValue({
    id: 2n,
    google_analytics_id: null,
    facebook_pixel_id: null,
    json_data: null,
  });
  for (const model of [
    mocks.db.baseVariantsPurchase,
    mocks.db.baseVariant,
    mocks.db.variantCategory,
    mocks.db.baseVariantsProductFile,
  ])
    model.findMany.mockResolvedValue([]);
  for (const model of [mocks.db.productFile, mocks.db.productIntegration, mocks.db.thirdPartyAnalytic])
    model.count.mockResolvedValue(0);
});

const page = (id: bigint, position: number, description: unknown[] = []) => ({
  id,
  position,
  title: `Page ${id}`,
  description,
  updated_at: new Date("2026-02-01T10:00:00.123Z"),
});

function licensed(rows: { serial: string | null }[]) {
  mocks.load.mockResolvedValue(loaded({ product: { ...loaded().product, flags: 1n << 6n } }));
  mocks.db.license.findMany.mockResolvedValue(rows);
}

const VERSION_ID = 7;
const purchasedVersion = () =>
  mocks.contentProvider.mockResolvedValue({ kind: "variant", variant: { id: VERSION_ID } });

describe("downloadPageFilters", () => {
  it("records the visit: a view event, the use count, the seen flag and the confirmed cookie", async () => {
    const request = chain();
    await expect(downloadPageFilters(request)).resolves.toEqual({ state: {} });

    expect(mocks.createEventBang).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "view",
        platform: "web",
        url_redirect_id: 11n,
        purchase_id: 5n,
        product_id: 3n,
        product_file_id: null,
      }),
    );
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(String(mocks.db.$executeRaw.mock.calls[0]![0].sql)).toContain("uses = COALESCE(uses, 0) + 1");
    expect(String(mocks.db.$executeRaw.mock.calls[1]![0].sql)).toContain("flags = COALESCE(flags, 0) |");
    expect(request.afterCookies).toHaveLength(1);
    expect(request.afterCookies[0]).toMatch(/^confirmed_redirect=.+; path=\/; httponly; samesite=lax$/u);
    expect(request.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("writes nothing when the access check redirects", async () => {
    mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, flags: 1n << 24n } }));
    const request = chain();
    await expect(downloadPageFilters(request)).resolves.toEqual({
      halt: { status: 302, location: "/r/tok123/expired", rescued: true },
    });

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
    await expect(downloadPageFilters(chain())).resolves.toEqual({
      halt: { status: 302, location: "/confirm?destination=download_page&id=tok123", rescued: true },
    });
  });

  describe("shapes Rails renders", () => {
    it.each([
      [
        "files Node does not list",
        () => mocks.contentItems.mockRejectedValue(new HandBackToRails("a file with a thumbnail")),
      ],
      ["integrations", () => mocks.db.productIntegration.count.mockResolvedValue(1)],
      ["third-party analytics", () => mocks.db.thirdPartyAnalytic.count.mockResolvedValue(1)],
      ["posts", () => mocks.downloadPosts.mockRejectedValue(new HandBackToRails("posts that share a sort time"))],
      [
        "a purchase the provider rules do not cover",
        () => mocks.contentProvider.mockRejectedValue(new HandBackToRails("a purchase of a SKU")),
      ],
      [
        "pages that share a position",
        () => mocks.db.richContent.findMany.mockResolvedValue([page(1n, 0), page(2n, 0)]),
      ],
      ["several licenses", () => licensed([{ serial: "A" }, { serial: "B" }])],
      [
        "a bundle purchase",
        () => mocks.load.mockResolvedValue(loaded({ purchase: { ...loaded().purchase, flags: 1n << 25n } })),
      ],
      [
        "a saved content page that is not a string",
        () =>
          mocks.load.mockResolvedValue(
            loaded({ purchase: { ...loaded().purchase, json_data: '{"last_content_page_id":5}' } }),
          ),
      ],
    ])("hand back %s without recording the visit", async (_, arrange) => {
      arrange();
      await expect(downloadPageFilters(chain())).rejects.toBeInstanceOf(HandBackToRails);

      expect(mocks.createEventBang).not.toHaveBeenCalled();
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    });

    it("hands back the mobile app token sign-in", async () => {
      const withToken = chain();
      withToken.request.queryString = "access_token=abc";
      await expect(downloadPageFilters(withToken)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it("renders the page of a purchased version and records the visit", async () => {
    purchasedVersion();
    await expect(downloadPageFilters(chain())).resolves.toEqual({ state: {} });
    expect(mocks.createEventBang).toHaveBeenCalledTimes(1);
  });

  describe("coffee product", () => {
    const coffee = () =>
      mocks.load.mockResolvedValue(loaded({ product: { ...loaded().product, native_type: "coffee" } }));

    it("redirects to the seller's coffee page without recording a visit", async () => {
      coffee();
      mocks.db.user.findUnique.mockResolvedValue({ id: 2n, username: "some_seller" });
      const outcome = await downloadPageFilters(chain());

      expect(outcome).toMatchObject({ halt: { status: 302, rescued: true } });
      expect((outcome as { halt: { location: string } }).halt.location).toMatch(
        /^https?:\/\/some-seller\.[^/]+\/coffee$/u,
      );
      expect(mocks.createEventBang).not.toHaveBeenCalled();
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
    });

    it("passes purchase_email through, escaped", async () => {
      coffee();
      mocks.db.user.findUnique.mockResolvedValue({ id: 2n, username: "seller" });
      const request = chain();
      request.request.queryString = "purchase_email=a%2Bb%40example.com";
      const outcome = await downloadPageFilters(request);

      expect((outcome as { halt: { location: string } }).halt.location).toMatch(
        /\/coffee\?purchase_email=a%2Bb%40example\.com$/u,
      );
    });

    it("hands back when the seller has no username to build a subdomain from", async () => {
      coffee();
      mocks.db.user.findUnique.mockResolvedValue({ id: 2n, username: null });
      await expect(downloadPageFilters(chain())).rejects.toBeInstanceOf(HandBackToRails);
    });
  });

  describe("downloadPageProps", () => {
    const props = (loggedInUser: unknown = null) =>
      downloadPageProps("tok123", { loggedInUser: loggedInUser as never, display: null, now: NOW });
    const embed = (id: bigint) => ({ type: "fileEmbed", attrs: { id: encrypt(id) } });

    it("lists the pages in position order and passes the embedded file ids, in order, to the files", async () => {
      mocks.db.richContent.findMany.mockResolvedValue([
        page(2n, 2, [{ type: "bulletList", content: [{ type: "listItem", content: [embed(40n)] }] }]),
        page(1n, 1, [embed(30n), embed(40n), { type: "paragraph" }]),
      ]);

      const { content } = await props();

      expect((content.rich_content_pages as { title: string }[]).map((entry) => entry.title)).toEqual([
        "Page 1",
        "Page 2",
      ]);
      expect(content.rich_content_pages?.[0]).toMatchObject({ variant_id: null, description: { type: "doc" } });
      expect(mocks.contentItems).toHaveBeenCalledWith(expect.anything(), null, [30n, 40n]);
    });

    it("lists the pages of the purchased version, with its id, and the files they embed", async () => {
      purchasedVersion();
      mocks.db.richContent.findMany.mockResolvedValue([page(1n, 1, [embed(30n)])]);

      const { content } = await props();

      expect(mocks.db.richContent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { entity_type: "BaseVariant", entity_id: 7n, deleted_at: null } }),
      );
      expect(content.rich_content_pages?.[0]).toMatchObject({ variant_id: encrypt(VERSION_ID) });
      expect(mocks.contentItems).toHaveBeenCalledWith(expect.anything(), null, [30n]);
    });

    it("hands back the license key and the seller's view of the pages of a version", async () => {
      purchasedVersion();
      licensed([{ serial: "KEY-1" }]);
      await expect(props()).rejects.toBeInstanceOf(HandBackToRails);

      mocks.db.richContent.findMany.mockResolvedValue([page(1n, 1)]);
      mocks.load.mockResolvedValue(loaded());
      await expect(props({ id: 2n })).rejects.toBeInstanceOf(HandBackToRails);
      await expect(props({ id: 9n })).resolves.toBeDefined();
    });

    it("lists no pages as null and every file", async () => {
      const { content } = await props();

      expect(content.rich_content_pages).toBeNull();
      expect(mocks.contentItems).toHaveBeenCalledWith(expect.anything(), null, []);
    });

    it("leaves the posts out when the pages have no posts block, and asks for them when one has", async () => {
      mocks.db.richContent.findMany.mockResolvedValue([page(1n, 1, [{ type: "paragraph" }])]);
      mocks.downloadPosts.mockResolvedValue([{ name: "Update" }]);
      expect((await props()).content.posts).toEqual([]);

      mocks.db.richContent.findMany.mockResolvedValue([
        page(1n, 1, [{ type: "bulletList", content: [{ type: "posts" }] }]),
      ]);
      expect((await props()).content.posts).toEqual([{ name: "Update" }]);
    });

    it("hands back the seller's own view of pages next to a video", async () => {
      mocks.db.richContent.findMany.mockResolvedValue([page(1n, 1)]);
      mocks.db.productFile.count.mockResolvedValue(1);

      await expect(props({ id: 2n })).rejects.toBeInstanceOf(HandBackToRails);
      await expect(props({ id: 9n })).resolves.toBeDefined();
    });

    it("shows the license key, the seats and the multi-seat flag of a licensed product", async () => {
      licensed([{ serial: "KEY-1" }]);
      mocks.load.mockResolvedValue(
        loaded({
          product: { ...loaded().product, flags: 1n << 6n },
          purchase: { ...loaded().purchase, flags: 1n << 21n, quantity: 3 },
        }),
      );

      expect((await props()).content.license).toEqual({ license_key: "KEY-1", is_multiseat_license: true, seats: 3 });
    });

    it.each([
      ["a product that is not licensed", () => mocks.db.license.findMany.mockResolvedValue([{ serial: "KEY" }])],
      ["a licensed purchase without a license row", () => licensed([])],
      ["a license without a serial", () => licensed([{ serial: null }])],
    ])("shows no license for %s", async (_, arrange) => {
      arrange();
      expect((await props()).content.license).toBeNull();
    });
  });

  describe("polls", () => {
    const poll = (data: string) => ({
      "x-inertia": "true",
      "x-inertia-partial-component": "UrlRedirects/DownloadPage",
      "x-inertia-partial-data": data,
    });
    const file = (id: bigint, filegroup: string, duration: number | null = null) => ({
      file: { id, filegroup, filetype: filegroup === "audio" ? "mp3" : "pdf", duration, flags: 0n },
      s3: null,
    });

    it("answers the requested props, writes nothing and sets no visit cookie", async () => {
      mocks.aliveProductFiles.mockResolvedValue([file(1n, "audio", 31), file(2n, "document")]);
      mocks.latestMediaLocations.mockResolvedValue(new Map());
      const request = chain({ headers: poll("audio_durations,latest_media_locations") });
      const outcome = (await downloadPageFilters(request)) as { state: Record<string, unknown> };

      expect(outcome.state[POLL_STATE_KEY]).toEqual({
        audio_durations: { [encrypt(1n)]: 31 },
        latest_media_locations: { [encrypt(1n)]: null, [encrypt(2n)]: null },
      });
      expect(mocks.createEventBang).not.toHaveBeenCalled();
      expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
      expect(request.afterCookies).toEqual([]);
    });

    it("answers only what was asked", async () => {
      mocks.aliveProductFiles.mockResolvedValue([file(1n, "audio", 31)]);
      const outcome = (await downloadPageFilters(chain({ headers: poll("audio_durations") }))) as {
        state: Record<string, unknown>;
      };

      expect(Object.keys(outcome.state[POLL_STATE_KEY] as object)).toEqual(["audio_durations"]);
      expect(mocks.latestMediaLocations).not.toHaveBeenCalled();
    });

    it("answers no locations for a redirect without a purchase", async () => {
      mocks.load.mockResolvedValue(loaded({ purchase: null }));
      mocks.aliveProductFiles.mockResolvedValue([file(1n, "audio", 31)]);
      const outcome = (await downloadPageFilters(chain({ headers: poll("latest_media_locations") }))) as {
        state: Record<string, unknown>;
      };

      expect(outcome.state[POLL_STATE_KEY]).toEqual({ latest_media_locations: {} });
    });
  });

  describe("setDownloadPageMeta", () => {
    const titleOf = async () => {
      const set = vi.fn<(tags: { title?: string }) => void>();
      await setDownloadPageMeta({ set } as never, "tok123", {} as never);
      return set.mock.calls[0]![0].title;
    };
    beforeEach(() => mocks.load.mockResolvedValue(loaded({ product: { ...loaded().product, name: "Course" } })));

    it("titles the page with the product, or with the version the purchase bought", async () => {
      expect(await titleOf()).toBe("Course");

      mocks.contentProvider.mockResolvedValue({ kind: "variant", variant: { id: 7, name: "Premium" } });
      expect(await titleOf()).toBe("Premium");
    });

    it("falls back to the product while the version is still untitled", async () => {
      mocks.contentProvider.mockResolvedValue({ kind: "variant", variant: { id: 7, name: "Untitled" } });
      expect(await titleOf()).toBe("Course");
    });
  });

  describe("lastContentPageId", () => {
    it("reads the saved page, and treats blank or missing values as nil", () => {
      expect(lastContentPageId('{"last_content_page_id":"abc"}')).toBe("abc");
      expect(lastContentPageId('{"last_content_page_id":"  "}')).toBeNull();
      expect(lastContentPageId('{"other":1}')).toBeNull();
      expect(lastContentPageId(null)).toBeNull();
    });
  });
});
