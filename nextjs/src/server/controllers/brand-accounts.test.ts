// Sellers::BrandAccountsController#create: what the permitted `username` reads as. brand_accounts_parity_spec.rb records a list under
// `username` creating the account with a generated username, as `permit` drops it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  build: vi.fn(),
  saveBang: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
  remoteIp: () => "127.0.0.1",
}));
vi.mock("../../lib/db.ts", () => ({ db: {} }));
vi.mock("../auth/resolve.ts", () => ({
  railsLoggedInUser: () => ({ id: 1n, email: "creator@example.com", confirmed_at: new Date() }),
}));
vi.mock("../infra/flipper.ts", () => ({ isFeatureEnabled: async () => true, userActor: () => ({}) }));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (run: () => unknown) => run() }));
vi.mock("../models/team-membership.ts", () => ({ TeamMemberships: { createBang: async () => ({}) } }));
vi.mock("../models/user.ts", () => ({
  deviseFriendlyToken: () => "token",
  findUser: mocks.findUser,
  setPassword: async () => undefined,
  Users: { build: mocks.build, saveBang: mocks.saveBang },
}));
vi.mock("./seller-json.ts", () => ({ accountEmailRequired: () => null }));
vi.mock("./settings-team-invitations.ts", () => ({ createOwnerMembershipIfNeeded: async () => undefined }));
vi.mock("./switch-seller-account.ts", () => ({ switchSellerAccount: async () => "cookie" }));

await import("./brand-accounts.ts");

const create = mocks.specs.find((spec) => spec.pattern === "/sellers/brand_accounts")!;
const request = (brandAccount: Record<string, unknown>) =>
  ({
    params: { brand_account: brandAccount },
    request: { host: "app.example.com" },
    chain: { session: { data: {} } },
    context: {},
  }) as unknown as MutationInput;

beforeEach(() => {
  mocks.build.mockReset().mockReturnValue({ set: vi.fn(), get: () => "brand", ivars: {} });
  mocks.saveBang.mockReset();
  mocks.findUser.mockReset().mockResolvedValue({ get: () => null });
});

describe("POST /sellers/brand_accounts", () => {
  const attributes = { email: "brand@example.com", name: "Brand Account" };

  it("builds the account with the username it is given", async () => {
    await create.run(request({ ...attributes, username: "brandaccount" }));
    expect(mocks.build).toHaveBeenCalledWith({
      email: "brand@example.com",
      username: "brandaccount",
      name: "Brand Account",
    });
  });

  it("reads a list under username as no username, which `permit` drops", async () => {
    await create.run(request({ ...attributes, username: ["brandaccount"] }));
    expect(mocks.build).toHaveBeenCalledWith({ email: "brand@example.com", username: null, name: "Brand Account" });
  });

  it("hands back a username that is a number, or a name that is a list", async () => {
    await expect(create.run(request({ ...attributes, username: 5 }))).rejects.toBeInstanceOf(HandBackToRails);
    await expect(create.run(request({ ...attributes, name: ["x"] }))).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
