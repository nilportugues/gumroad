import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ encryptNumeric: (id: number) => id * 10 }));
vi.mock("../models/concerns/ruby-numeric.ts", () => ({ rubyToI: (value: unknown) => Number(value) }));
vi.mock("../models/sql.ts", () => ({ selectRows: mocks.selectRows, column: () => "", table: () => "" }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../policies/affiliate-request.ts", () => ({ affiliateRequestPolicy: { update: () => mocks.allowed() } }));
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, step: (context: unknown) => unknown) => {
    if (mocks.guardRedirect()) return mocks.guardRedirect();
    await step({ seller: { id: 3n } });
    return null;
  },
}));

await import("./affiliate-requests-onboarding-form.ts");

const update = mocks.specs.find((spec) => spec.method === "PATCH")!.run;

const call = (body: Record<string, unknown>, headers: Record<string, string> = { "x-inertia": "true" }) =>
  update({
    params: body,
    routeParams: {},
    request: { headers: new Headers(headers) },
    context: { currentSeller: { id: 3n } },
    url: new URL("https://example.com/"),
  } as unknown as MutationInput);

const wrong = { status: 302, location: "/affiliates/onboarding", flash: { alert: "Something went wrong" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowed.mockReturnValue(true);
  // The seller's published product 1 has the numeric id 10; selectRows answers the pending-request lookup afterwards.
  mocks.selectRows.mockResolvedValueOnce([{ id: 1n }]);
});

describe("AffiliateRequests::OnboardingFormController#update", () => {
  it("registers both verbs", () => {
    expect(mocks.specs.map((spec) => spec.method)).toEqual(["PATCH", "PUT"]);
  });

  it("returns the sign-in redirect of the guard", async () => {
    mocks.guardRedirect.mockReturnValue({ status: 302, location: "/login" });
    expect(await call({ products: [] })).toEqual({ status: 302, location: "/login" });
  });

  it("hands a request that is not an Inertia visit back to Rails", async () => {
    await expect(call({ products: [] }, {})).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers the rescued refusal for a role the policy rejects", async () => {
    mocks.allowed.mockReturnValue(false);
    expect(await call({ products: [] })).toEqual(wrong);
  });

  it("answers the rescued refusal for a body without products", async () => {
    expect(await call({})).toEqual(wrong);
  });

  it("hands products that are not a list of hashes back to Rails", async () => {
    await expect(call({ products: "x" })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("refuses to disable every product while a request is pending", async () => {
    mocks.selectRows.mockResolvedValueOnce([{ one: 1 }]);
    expect(await call({ products: [{ id: 10, enabled: false }] })).toEqual({
      status: 302,
      location: "/affiliates/onboarding",
      flash: { alert: "You need to have at least one product enabled since there are some pending affiliate requests" },
    });
  });

  it("ignores an enabled product that is not the seller's", async () => {
    mocks.selectRows.mockResolvedValueOnce([{ one: 1 }]);
    const result = await call({ products: [{ id: 99, enabled: true }] });
    expect(result).toMatchObject({ location: "/affiliates/onboarding" });
  });

  it("hands a form that keeps a product enabled back to Rails", async () => {
    await expect(call({ products: [{ id: 10, enabled: true }] })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("reads the text false as enabled, as Ruby truthiness does", async () => {
    await expect(call({ products: [{ id: 10, enabled: "false" }] })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a form that disables everything with nothing pending back to Rails", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    await expect(call({ products: [{ id: 10, enabled: false }] })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
