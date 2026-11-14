import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError, type Chain } from "../../controllers/application-controller.ts";

const mocks = vi.hoisted(() => ({ load: vi.fn(), buildGateInput: vi.fn() }));

vi.mock("./unavailable.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), load: mocks.load }));
vi.mock("./download-page.ts", () => ({ buildGateInput: mocks.buildGateInput }));

const { deliveryFilters } = await import("./delivery.ts");

const purchaseFacts = (overrides: Record<string, unknown> = {}) => ({
  withdrawn: false,
  purchaserId: 7n,
  rentalExpired: false,
  accessRevoked: false,
  isTestPurchase: false,
  ipAddress: "203.0.113.9",
  membershipInactive: false,
  ...overrides,
});

const gateInput = (overrides: Record<string, unknown> = {}) => ({
  token: "tok123",
  path: "/r/tok123",
  fullpath: "/r/tok123",
  display: null,
  isPoll: false,
  hasBeenSeen: false,
  purchase: purchaseFacts(),
  viewer: null,
  viewerOwnsSubscription: false,
  confirmedCookie: false,
  remoteIp: "198.51.100.1",
  loginUrl: (next: string) => `https://app.example.com/login?next=${encodeURIComponent(next)}`,
  ...overrides,
});

function chain(path: string, options: { query?: string; accept?: string; signedIn?: boolean } = {}) {
  return {
    request: {
      method: "GET",
      path,
      queryString: options.query ?? "",
      headers: new Headers({ accept: options.accept ?? "text/html" }),
      cookies: new Map(),
    },
    now: new Date("2026-03-01T12:00:00Z"),
    headers: new Headers(),
    auth: {
      context: { loggedInUser: options.signedIn ? { id: 7n } : null, currentSeller: null, impersonatedUser: null },
      effects: {},
    },
    afterCookies: [] as string[],
  } as unknown as Chain;
}

const arrange = (input: Record<string, unknown>, loaded: Record<string, unknown> = {}) => {
  mocks.load.mockResolvedValue({ redirect: { token: "tok123" }, purchase: { id: 5n }, ...loaded });
  mocks.buildGateInput.mockImplementation(async (_chain, _loaded, { destination }: { destination: string }) => ({
    gate: gateInput({ ...input, destination }),
    viewer: null,
  }));
};

beforeEach(() => {
  vi.resetAllMocks();
  arrange({});
});

describe("deliveryFilters", () => {
  it("hands back a request that passes the gate, since the action signs URLs and writes", async () => {
    await expect(deliveryFilters("show")(chain("/r/tok123"))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each([
    ["show", "/r/tok123"],
    ["stream", "/s/tok123/abc"],
    ["read", "/read/tok123"],
    ["play", "/d/tok123/play"],
    ["hls_playlist", "/r/tok123/abc/index.m3u8"],
    ["download_archive", "/zip/tok123"],
    ["download_product_files", "/r/tok123/product_files"],
    ["download_subtitle_file", "/r/tok123/abc/def"],
    ["subtitle_file_vtt", "/r/tok123/abc/def/captions.vtt"],
  ] as const)("sends the confirm page the %s action as its destination", async (action, path) => {
    arrange({ hasBeenSeen: true, path }, {});
    await expect(deliveryFilters(action)(chain(path))).resolves.toEqual({
      halt: { status: 302, location: `/confirm?destination=${action}&id=tok123`, rescued: true },
    });
    expect(mocks.buildGateInput).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      destination: action,
      isPoll: false,
    });
  });

  it("redirects an expired rental, revoked access and an inactive membership to their pages", async () => {
    arrange({ purchase: purchaseFacts({ rentalExpired: true }) });
    await expect(deliveryFilters("show")(chain("/r/tok123"))).resolves.toMatchObject({
      halt: { location: "/r/tok123/rental_expired" },
    });
    arrange({ purchase: purchaseFacts({ accessRevoked: true }) });
    await expect(deliveryFilters("stream")(chain("/s/tok123"))).resolves.toMatchObject({
      halt: { location: "/r/tok123/expired" },
    });
    arrange({ purchase: purchaseFacts({ membershipInactive: true }) });
    await expect(deliveryFilters("download_archive")(chain("/zip/tok123"))).resolves.toMatchObject({
      halt: { location: "/r/tok123/membership_inactive" },
    });
  });

  it("sends a signed-in stranger to the purchaser check with the delivery path", async () => {
    arrange({ viewer: { id: 9n, isTeamMember: false }, path: "/s/tok123" });
    await expect(deliveryFilters("stream")(chain("/s/tok123", { signedIn: true }))).resolves.toMatchObject({
      halt: { location: "/r/tok123/check_purchaser?next=%2Fs%2Ftok123" },
    });
  });

  it("answers 404 for a withdrawn purchase", async () => {
    arrange({ purchase: purchaseFacts({ withdrawn: true }) });
    await expect(deliveryFilters("show")(chain("/r/tok123"))).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands back a 404 whose page depends on a non-HTML format", async () => {
    arrange({ purchase: purchaseFacts({ withdrawn: true }) });
    await expect(
      deliveryFilters("download_product_files")(chain("/r/tok123/product_files", { accept: "application/json" })),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers 404 for an unknown token", async () => {
    mocks.load.mockRejectedValue(new RoutingError("Not Found"));
    await expect(deliveryFilters("hls_playlist")(chain("/r/tok123/abc/index.m3u8"))).rejects.toBeInstanceOf(
      RoutingError,
    );
  });

  it("hands back the mobile app token sign-in", async () => {
    await expect(deliveryFilters("show")(chain("/r/tok123", { query: "access_token=abc" }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    expect(mocks.buildGateInput).not.toHaveBeenCalled();
  });

  describe("read", () => {
    it("redirects a refused read to the home page when signed out and the library when signed in", async () => {
      arrange({ purchase: purchaseFacts({ withdrawn: true }) });
      await expect(deliveryFilters("read")(chain("/read/tok123"))).resolves.toEqual({
        halt: { status: 302, location: "/", rescued: true },
      });
      await expect(deliveryFilters("read")(chain("/read/tok123/abc", { signedIn: true }))).resolves.toEqual({
        halt: { status: 302, location: "/library", rescued: true },
      });
    });

    it("redirects an unknown token the same way", async () => {
      mocks.load.mockRejectedValue(new RoutingError("Not Found"));
      await expect(deliveryFilters("read")(chain("/read/tok123"))).resolves.toMatchObject({ halt: { location: "/" } });
    });

    it("keeps the confirm and expiry redirects", async () => {
      arrange({ purchase: purchaseFacts({ accessRevoked: true }) });
      await expect(deliveryFilters("read")(chain("/read/tok123"))).resolves.toMatchObject({
        halt: { location: "/r/tok123/expired" },
      });
    });
  });

  describe("play", () => {
    it("answers 404 for a redirect without a purchase, which has no player", async () => {
      arrange({ purchase: null }, { purchase: null });
      await expect(deliveryFilters("play")(chain("/d/tok123/play"))).rejects.toBeInstanceOf(RoutingError);
    });

    it("hands back a purchase, whose build, feature flag and grant are Rails'", async () => {
      await expect(deliveryFilters("play")(chain("/d/tok123/play"))).rejects.toBeInstanceOf(HandBackToRails);
    });
  });

  describe("smil", () => {
    it("skips check_permissions: a withdrawn purchase is not refused here", async () => {
      arrange({ purchase: purchaseFacts({ withdrawn: true, rentalExpired: true }) });
      await expect(deliveryFilters("smil")(chain("/r/tok123/abc/stream.smil"))).rejects.toBeInstanceOf(HandBackToRails);
    });

    it("answers 404 for a test purchase to anyone but its buyer or a team member", async () => {
      arrange({ purchase: purchaseFacts({ isTestPurchase: true }), viewer: { id: 9n, isTeamMember: false } });
      await expect(
        deliveryFilters("smil")(chain("/r/tok123/abc/stream.smil", { signedIn: true })),
      ).rejects.toBeInstanceOf(RoutingError);
      arrange({ purchase: purchaseFacts({ isTestPurchase: true }), viewer: null });
      await expect(deliveryFilters("smil")(chain("/r/tok123/abc/stream.smil"))).rejects.toBeInstanceOf(RoutingError);
    });

    it("hands back a test purchase opened by its buyer or a team member", async () => {
      arrange({ purchase: purchaseFacts({ isTestPurchase: true }), viewer: { id: 7n, isTeamMember: false } });
      await expect(
        deliveryFilters("smil")(chain("/r/tok123/abc/stream.smil", { signedIn: true })),
      ).rejects.toBeInstanceOf(HandBackToRails);
      arrange({ purchase: purchaseFacts({ isTestPurchase: true }), viewer: { id: 9n, isTeamMember: true } });
      await expect(
        deliveryFilters("smil")(chain("/r/tok123/abc/stream.smil", { signedIn: true })),
      ).rejects.toBeInstanceOf(HandBackToRails);
    });
  });
});
