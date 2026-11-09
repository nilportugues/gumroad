import { describe, expect, it } from "vitest";

import { isPollingRequest } from "./download-page.ts";
import { decideAccess, type GateInput, type GatePurchase } from "./download-gate.ts";

const purchase = (overrides: Partial<GatePurchase> = {}): GatePurchase => ({
  withdrawn: false,
  purchaserId: 7n,
  rentalExpired: false,
  accessRevoked: false,
  isTestPurchase: false,
  ipAddress: "203.0.113.9",
  membershipInactive: false,
  ...overrides,
});

const input = (overrides: Partial<GateInput> = {}): GateInput => ({
  token: "tok123",
  path: "/d/tok123",
  fullpath: "/d/tok123",
  display: null,
  isPoll: false,
  hasBeenSeen: false,
  purchase: purchase(),
  viewer: null,
  viewerOwnsSubscription: false,
  confirmedCookie: false,
  remoteIp: "198.51.100.1",
  loginUrl: (next) => `https://app.example.com/login?next=${encodeURIComponent(next)}`,
  ...overrides,
});

const redirectTo = (location: string) => ({ kind: "redirect", location });

describe("decideAccess", () => {
  it("lets a first visit through", () => {
    expect(decideAccess(input())).toEqual({ kind: "pass" });
  });

  it("answers 404 for a refunded or charged back purchase", () => {
    expect(decideAccess(input({ purchase: purchase({ withdrawn: true }) }))).toEqual({ kind: "notFound" });
  });

  it("moves a poll of a withdrawn purchase to the expired page", () => {
    expect(decideAccess(input({ isPoll: true, purchase: purchase({ withdrawn: true }) }))).toEqual(redirectTo("/r/tok123/expired"));
  });

  it("sends a signed-in stranger to the purchaser check with the path to come back to", () => {
    expect(decideAccess(input({ viewer: { id: 9n, isTeamMember: false } }))).toEqual(redirectTo("/r/tok123/check_purchaser?next=%2Fd%2Ftok123"));
  });

  it.each([
    ["the purchaser", { viewer: { id: 7n, isTeamMember: false } }],
    ["a team member", { viewer: { id: 9n, isTeamMember: true } }],
    ["the subscription owner", { viewer: { id: 9n, isTeamMember: false }, viewerOwnsSubscription: true }],
  ])("does not send %s to the purchaser check", (_, overrides) => {
    expect(decideAccess(input(overrides))).toEqual({ kind: "pass" });
  });

  it("does not send a guest purchase's visitor to the purchaser check", () => {
    expect(decideAccess(input({ viewer: { id: 9n, isTeamMember: false }, purchase: purchase({ purchaserId: null }) }))).toEqual({ kind: "pass" });
  });

  it("checks the purchaser before the expiry of a rental", () => {
    const rental = purchase({ rentalExpired: true });
    expect(decideAccess(input({ purchase: rental, viewer: { id: 9n, isTeamMember: false } }))).toEqual(redirectTo("/r/tok123/check_purchaser?next=%2Fd%2Ftok123"));
    expect(decideAccess(input({ purchase: rental }))).toEqual(redirectTo("/r/tok123/rental_expired"));
  });

  it("sends revoked access to the expired page and an inactive membership to its own", () => {
    expect(decideAccess(input({ purchase: purchase({ accessRevoked: true }) }))).toEqual(redirectTo("/r/tok123/expired"));
    expect(decideAccess(input({ purchase: purchase({ membershipInactive: true }) }))).toEqual(redirectTo("/r/tok123/membership_inactive"));
  });

  describe("a seller's own test purchase", () => {
    const testPurchase = purchase({ isTestPurchase: true, purchaserId: 7n });

    it("opens for the seller and for a team member", () => {
      expect(decideAccess(input({ purchase: testPurchase, viewer: { id: 7n, isTeamMember: false } }))).toEqual({ kind: "pass" });
      expect(decideAccess(input({ purchase: testPurchase, viewer: { id: 9n, isTeamMember: true } }))).toEqual({ kind: "pass" });
    });

    it("answers 404 to another signed-in visitor, even one who has seen the link", () => {
      expect(decideAccess(input({ purchase: testPurchase, hasBeenSeen: true, confirmedCookie: true, viewer: { id: 9n, isTeamMember: false } }))).toEqual({ kind: "notFound" });
    });

    it("asks a signed-out visitor to log in, returning to the full path", () => {
      expect(decideAccess(input({ purchase: testPurchase, fullpath: "/d/tok123?display=mobile_app" }))).toEqual(
        redirectTo("https://app.example.com/login?next=%2Fd%2Ftok123%3Fdisplay%3Dmobile_app"),
      );
    });
  });

  describe("a link that was already opened", () => {
    it("asks for the purchase email", () => {
      expect(decideAccess(input({ hasBeenSeen: true }))).toEqual(redirectTo("/confirm?destination=download_page&id=tok123"));
    });

    it("forwards the display param between destination and id, as to_query sorts them", () => {
      expect(decideAccess(input({ hasBeenSeen: true, display: "mobile_app" }))).toEqual(redirectTo("/confirm?destination=download_page&display=mobile_app&id=tok123"));
    });

    it.each([
      ["the confirmed cookie", { confirmedCookie: true }],
      ["the subscription owner", { viewerOwnsSubscription: true }],
      ["the purchaser", { viewer: { id: 7n, isTeamMember: false } }],
      ["the buying IP address", { remoteIp: "203.0.113.9" }],
    ])("lets in %s", (_, overrides) => {
      expect(decideAccess(input({ hasBeenSeen: true, ...overrides }))).toEqual({ kind: "pass" });
    });

    it("lets a redirect without a purchase through", () => {
      expect(decideAccess(input({ hasBeenSeen: true, purchase: null }))).toEqual({ kind: "pass" });
    });
  });
});

describe("isPollingRequest", () => {
  const poll = (data: string, extra: Record<string, string> = {}) =>
    new Headers({ "x-inertia": "true", "x-inertia-partial-component": "UrlRedirects/DownloadPage", "x-inertia-partial-data": data, ...extra });

  it("recognises a partial reload of only the polled props", () => {
    expect(isPollingRequest(poll("audio_durations"))).toBe(true);
    expect(isPollingRequest(poll("audio_durations,latest_media_locations"))).toBe(true);
  });

  it("rejects a reload that asks for anything else, names nothing, or targets another component", () => {
    expect(isPollingRequest(poll("audio_durations,content"))).toBe(false);
    expect(isPollingRequest(poll(""))).toBe(false);
    expect(isPollingRequest(poll("audio_durations", { "x-inertia-partial-component": "UrlRedirects/Expired" }))).toBe(false);
    expect(isPollingRequest(new Headers())).toBe(false);
  });
});

describe("decideAccess destination", () => {
  it("sends the confirm page the action that was asked for", () => {
    expect(decideAccess(input({ hasBeenSeen: true, destination: "play" }))).toEqual(redirectTo("/confirm?destination=play&id=tok123"));
  });
});
