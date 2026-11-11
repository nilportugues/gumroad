import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findAliveCollaborator: vi.fn(),
  hasInvitation: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/dashboard/collaborators.ts", () => ({
  findAliveCollaborator: mocks.findAliveCollaborator,
  hasCollaboratorInvitation: mocks.hasInvitation,
}));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../policies/collaborator.ts", () => ({
  collaboratorPolicy: { destroy: () => mocks.allowed() },
  collaboratorInvitationPolicy: { accept: () => mocks.allowed(), decline: () => mocks.allowed() },
}));
vi.mock("../policies/authorize.ts", () => ({
  authorize: (query: () => boolean) => {
    if (!query()) throw new Error("not allowed");
  },
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

await import("./collaborator-incomings-mutations.ts");

const find = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const call = (run: MutationSpec["run"], id = "abc") =>
  run({ routeParams: { id }, params: {} } as unknown as MutationInput);
const LOGIN = { status: 302, location: "/login?next=%2Fx", rescued: true };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findAliveCollaborator.mockResolvedValue({ id: 7, seller_id: 9, affiliate_user_id: 3 });
  mocks.hasInvitation.mockResolvedValue(true);
  mocks.allowed.mockReturnValue(true);
});

describe.each([
  ["POST", "/collaborators/incomings/:id/accept"],
  ["POST", "/collaborators/incomings/:id/decline"],
])("%s %s", (method, pattern) => {
  const run = find(method, pattern);

  it("answers not found for an id that decodes to nothing", async () => {
    await expect(call(run, "unknown")).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers not found for a collaboration that is gone, even to a visitor who is signed out", async () => {
    mocks.findAliveCollaborator.mockResolvedValue(null);
    mocks.guardRedirect.mockReturnValue(LOGIN);
    await expect(call(run)).rejects.toBeInstanceOf(RoutingError);
  });

  it("sends a signed-out visitor to sign in before looking for the invitation", async () => {
    mocks.guardRedirect.mockReturnValue(LOGIN);
    mocks.hasInvitation.mockResolvedValue(false);
    expect(await call(run)).toEqual(LOGIN);
    expect(mocks.hasInvitation).not.toHaveBeenCalled();
  });

  it("answers not found when the invitation was already answered", async () => {
    mocks.hasInvitation.mockResolvedValue(false);
    await expect(call(run)).rejects.toBeInstanceOf(RoutingError);
  });

  it("refuses a seller the policy does not allow", async () => {
    mocks.allowed.mockReturnValue(false);
    await expect(call(run)).rejects.toThrow("not allowed");
  });

  it("hands the answer to Rails once the guards pass", async () => {
    await expect(call(run)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("DELETE /collaborators/incomings/:id", () => {
  const run = find("DELETE", "/collaborators/incomings/:id");

  it("answers not found for a collaboration that is gone", async () => {
    mocks.findAliveCollaborator.mockResolvedValue(null);
    await expect(call(run)).rejects.toBeInstanceOf(RoutingError);
  });

  it("does not look for an invitation", async () => {
    await expect(call(run)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.hasInvitation).not.toHaveBeenCalled();
  });

  it("returns the sign-in redirect for a visitor who is signed out", async () => {
    mocks.guardRedirect.mockReturnValue(LOGIN);
    expect(await call(run)).toEqual(LOGIN);
  });

  it("refuses a seller the policy does not allow", async () => {
    mocks.allowed.mockReturnValue(false);
    await expect(call(run)).rejects.toThrow("not allowed");
  });
});
