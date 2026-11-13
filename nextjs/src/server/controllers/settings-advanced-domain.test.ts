// The custom domain branch of Settings::AdvancedController#update: DNS is read before the first write, and a domain that points at
// Gumroad is saved verified.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  guard: vi.fn(),
  pointsToGumroad: vi.fn(),
  unblockActive: vi.fn(),
  userUpdate: vi.fn(),
  userSave: vi.fn(),
  stored: vi.fn(),
  save: vi.fn(),
  build: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/settings/guard.ts", () => ({ settingsGuard: () => mocks.guard }));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (fn: () => unknown) => fn() }));
vi.mock("../services/custom-domain-verification.ts", () => ({ customDomainPointsToGumroad: mocks.pointsToGumroad }));
vi.mock("../models/blocked-customer-object.ts", () => ({
  activeBlockedEmails: vi.fn(),
  blockEmailBang: vi.fn(),
  unblockActive: mocks.unblockActive,
}));
vi.mock("../models/custom-domain.ts", () => ({
  aliveCustomDomainOf: mocks.stored,
  CustomDomainDeletable: { markDeletedBang: vi.fn() },
  CustomDomains: { build: mocks.build, save: mocks.save },
}));
vi.mock("../models/user.ts", async (original) => {
  const seller = {
    get: (key: string) => (key === "id" ? 7n : null),
    attributes: { id: 7n },
    errors: { fullMessages: () => [] },
  };
  return {
    ...(await original<typeof import("../models/user.ts")>()),
    findUserBang: () => Promise.resolve(seller),
    Users: { withLock: (_record: unknown, fn: () => unknown) => fn(), update: mocks.userUpdate, save: mocks.userSave },
  };
});

await import("./settings-mutations.ts");

const advanced = mocks.specs.find((spec) => spec.method === "PUT" && spec.pattern === "/settings/advanced")!;
const input = (body: Record<string, unknown>): MutationInput =>
  ({
    params: body,
    url: new URL("http://example.com/settings/advanced"),
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    context: { currentSeller: { id: 7n } },
    request: { headers: new Headers({ "content-type": "application/json" }) },
  }) as unknown as MutationInput;
const record = (state: string) => {
  const values: Record<string, unknown> = { state };
  return {
    values,
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => void (values[key] = value),
    errors: { fullMessages: () => ["boom"] },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue(null);
  mocks.pointsToGumroad.mockResolvedValue(false);
  mocks.userSave.mockResolvedValue(true);
  mocks.stored.mockResolvedValue(null);
  mocks.save.mockResolvedValue(true);
});

describe("PUT /settings/advanced with a custom domain", () => {
  it("looks the domain up before any write", async () => {
    mocks.build.mockReturnValue(record("unverified"));

    await advanced.run(input({ domain: "shop.example.com", user: { notification_endpoint: "" } }));

    expect(mocks.pointsToGumroad).toHaveBeenCalledWith("shop.example.com");
    expect(mocks.pointsToGumroad.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.unblockActive.mock.invocationCallOrder[0]!,
    );
  });

  it("verifies a new domain that points at Gumroad", async () => {
    mocks.pointsToGumroad.mockResolvedValue(true);
    const built = record("unverified");
    mocks.build.mockReturnValue(built);

    await advanced.run(input({ domain: "shop.example.com", user: { notification_endpoint: "" } }));

    expect(built.values).toMatchObject({ state: "verified", failed_verification_attempts_count: 0 });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("keeps a verified domain verified and leaves its failed attempts alone", async () => {
    mocks.pointsToGumroad.mockResolvedValue(true);
    const stored = record("verified");
    mocks.stored.mockResolvedValue(stored);

    await advanced.run(input({ domain: "new.example.com", user: { notification_endpoint: "" } }));

    expect(stored.values).toEqual({ state: "verified", domain: "new.example.com" });
  });

  it("does not look a blank domain up", async () => {
    mocks.build.mockReturnValue(record("unverified"));

    await advanced.run(input({ domain: "   ", user: { notification_endpoint: "" } }));

    expect(mocks.pointsToGumroad).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("builds an unverified domain for a seller without one and saves it once", async () => {
    const built = record("unverified");
    mocks.build.mockReturnValue(built);

    const result = await advanced.run(input({ domain: "Shop.Example.com", user: { notification_endpoint: "" } }));

    expect(mocks.build).toHaveBeenCalledWith({ user_id: 7 });
    expect(built.values).toMatchObject({ domain: "Shop.Example.com", state: "unverified" });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 303, flash: { notice: "Your account has been updated!" } });
  });

  it("marks the stored verified domain unverified, since DNS no longer points at Gumroad", async () => {
    const stored = record("verified");
    mocks.stored.mockResolvedValue(stored);

    await advanced.run(input({ domain: "new.example.com", user: { notification_endpoint: "" } }));

    expect(mocks.build).not.toHaveBeenCalled();
    expect(stored.values).toMatchObject({ domain: "new.example.com", state: "unverified" });
  });

  it("redirects with the model errors and does not save the seller when the domain is refused", async () => {
    mocks.build.mockReturnValue(record("unverified"));
    mocks.save.mockResolvedValue(false);

    const result = await advanced.run(input({ domain: "-bad.example.com", user: { notification_endpoint: "" } }));

    expect(result).toMatchObject({ status: 302, location: "/settings/advanced", flash: { alert: "boom" } });
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.userSave).not.toHaveBeenCalled();
  });
});
