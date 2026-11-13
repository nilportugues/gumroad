import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, ParameterMissing, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  profileUser: vi.fn(),
  subdomainWithProtocol: vi.fn(),
  hasEnabled: vi.fn(),
  hasUnattended: vi.fn(),
  canPerformAction: vi.fn(),
  sellerRequestById: vi.fn(),
  build: vi.fn(),
  valid: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./users-controller.ts", () => ({ profileUser: mocks.profileUser, requireHtml: vi.fn() }));
vi.mock("../models/user.ts", () => ({
  subdomainWithProtocol: mocks.subdomainWithProtocol,
  Users: { load: (user: unknown) => user },
}));
vi.mock("../models/affiliate-request.ts", () => ({
  ACTION_APPROVE: "approve",
  ACTION_IGNORE: "ignore",
  AffiliateRequests: { build: mocks.build, valid: mocks.valid },
  canPerformAction: mocks.canPerformAction,
  hasEnabledSelfServiceProducts: mocks.hasEnabled,
  hasUnattendedRequests: mocks.hasUnattended,
  sellerRequestById: mocks.sellerRequestById,
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../policies/affiliate-request.ts", () => ({
  affiliateRequestPolicy: { update: () => mocks.allowed(), approve_all: () => mocks.allowed() },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "unknown" ? null : 7) }));
// The guard runs the step against a seller context, and returns the redirect it was told to give.
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, step: (context: unknown) => unknown) => {
    if (mocks.guardRedirect()) return mocks.guardRedirect();
    await step({ seller: { id: 3n } });
    return null;
  },
}));

await import("./affiliate-requests-mutations.ts");

const find = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const call = (run: MutationSpec["run"], input: Partial<MutationInput> = {}) =>
  run({ params: {}, routeParams: { id: "abc" }, context: { currentSeller: { id: 3n } }, ...input } as MutationInput);
const body = (affiliateRequest: unknown) => ({ params: { affiliate_request: affiliateRequest } });
const ALERT = (message: string) => ({ status: 302, location: "/affiliates", flash: { alert: message } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.profileUser.mockResolvedValue({ id: 3n, username: "seller" });
  mocks.subdomainWithProtocol.mockReturnValue(null);
  mocks.hasEnabled.mockResolvedValue(true);
  mocks.hasUnattended.mockResolvedValue(false);
  mocks.canPerformAction.mockResolvedValue(true);
  mocks.sellerRequestById.mockResolvedValue({ name: "Ada", email: "ada@example.com", state: "created" });
  mocks.allowed.mockReturnValue(true);
});

describe("GET /:username/affiliates", () => {
  const run = find("GET", "/:username/affiliates");

  it("sends a seller with a subdomain to it", async () => {
    mocks.subdomainWithProtocol.mockReturnValue("https://seller.example.com");
    expect(await call(run)).toEqual({
      status: 301,
      location: "https://seller.example.com/affiliates",
      rescued: true,
    });
  });

  it("hands a seller without a subdomain to Rails", async () => {
    await expect(call(run)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("POST /affiliate_requests", () => {
  const run = find("POST", "/affiliate_requests");
  const invalid = (...messages: string[]) => mocks.build.mockReturnValue({ errors: { fullMessages: () => messages } });

  it("redirects with the errors joined as a sentence when the request is invalid", async () => {
    invalid("Name can't be blank", "Email is invalid", "Promotion text can't be blank");
    mocks.valid.mockResolvedValue(false);
    expect(await call(run, body({ email: "nope" }))).toEqual(
      ALERT("Name can't be blank, Email is invalid, and Promotion text can't be blank"),
    );
  });

  it("joins two errors with and", async () => {
    invalid("Email is invalid", "You have already requested to become an affiliate of this creator.");
    mocks.valid.mockResolvedValue(false);
    expect(await call(run, body({ email: "nope" }))).toEqual(
      ALERT("Email is invalid and You have already requested to become an affiliate of this creator."),
    );
  });

  it("drops a hash or an array parameter, as permit does", async () => {
    invalid("Name can't be blank");
    mocks.valid.mockResolvedValue(false);
    await call(run, body({ name: { a: "b" }, email: ["x"], promotion_text: "hi" }));
    expect(mocks.build).toHaveBeenCalledWith({ seller_id: 3n, name: null, email: null, promotion_text: "hi" });
  });

  it("hands a valid request to Rails", async () => {
    invalid();
    mocks.valid.mockResolvedValue(true);
    await expect(call(run, body({ name: "Ada" }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers not found when no self-service product is enabled", async () => {
    mocks.hasEnabled.mockResolvedValue(false);
    await expect(call(run, body({ name: "Ada" }))).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers a bad request for a missing, blank or empty affiliate_request", async () => {
    for (const value of [undefined, null, "", {}])
      await expect(call(run, body(value))).rejects.toBeInstanceOf(ParameterMissing);
  });

  it("hands back a scalar or list affiliate_request, which permit raises on", async () => {
    for (const value of ["text", ["a"]])
      await expect(call(run, body(value))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a numeric parameter", async () => {
    await expect(call(run, body({ name: 5 }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("PATCH /affiliate_requests/:id", () => {
  const run = find("PATCH", "/affiliate_requests/:id");

  it("answers not found for a request that is not the seller's", async () => {
    mocks.sellerRequestById.mockResolvedValue(null);
    await expect(call(run, body({ action: "approve" }))).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers not found for an id that does not decrypt", async () => {
    await expect(call(run, { ...body({ action: "approve" }), routeParams: { id: "unknown" } })).rejects.toBeInstanceOf(
      RoutingError,
    );
    expect(mocks.sellerRequestById).not.toHaveBeenCalled();
  });

  it("redirects with the guard's answer when the seller is signed out", async () => {
    mocks.guardRedirect.mockReturnValue({ status: 302, location: "/login?next=%2Faffiliate_requests%2Fabc" });
    expect(await call(run, body({ action: "approve" }))).toEqual({
      status: 302,
      location: "/login?next=%2Faffiliate_requests%2Fabc",
    });
  });

  it("says the request was already processed when the transition is not allowed", async () => {
    mocks.canPerformAction.mockResolvedValue(false);
    expect(await call(run, body({ action: "ignore" }))).toEqual(
      ALERT("Ada's affiliate request has been already processed."),
    );
  });

  it("names an action that is not valid", async () => {
    expect(await call(run, body({ action: "delete" }))).toEqual(
      ALERT("delete is not a valid affiliate request action"),
    );
  });

  it("names a missing action as an empty string", async () => {
    expect(await call(run, body({ other: "x" }))).toEqual(ALERT(" is not a valid affiliate request action"));
  });

  it("hands an allowed approve or ignore to Rails", async () => {
    await expect(call(run, body({ action: "approve" }))).rejects.toBeInstanceOf(HandBackToRails);
    await expect(call(run, body({ action: "ignore" }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("GET /affiliate_requests/:id/approve", () => {
  const run = find("GET", "/affiliate_requests/:id/approve");

  it("answers not found for a request that is not the seller's", async () => {
    mocks.sellerRequestById.mockResolvedValue(null);
    await expect(call(run)).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands the status page to Rails", async () => {
    await expect(call(run)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("POST /affiliate_requests/approve_all", () => {
  const run = find("POST", "/affiliate_requests/approve_all");

  it("tells the seller everything is approved when nothing is pending", async () => {
    expect(await call(run)).toEqual({
      status: 303,
      location: "/affiliates",
      flash: { notice: "Approved all pending affiliate requests!" },
    });
  });

  it("hands pending requests to Rails", async () => {
    mocks.hasUnattended.mockResolvedValue(true);
    await expect(call(run)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
