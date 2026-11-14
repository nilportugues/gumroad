import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findAliveCollaborator: vi.fn(),
  hasInvitation: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
  endCollaboration: vi.fn(),
  destroyCollaboration: vi.fn(),
  destroyInvitation: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../page-props/dashboard/collaborators.ts", () => ({
  findAliveCollaborator: mocks.findAliveCollaborator,
  hasCollaboratorInvitation: mocks.hasInvitation,
}));
vi.mock("./collaborator-destroy.ts", () => ({
  endCollaboration: mocks.endCollaboration,
  destroyCollaboration: mocks.destroyCollaboration,
}));
vi.mock("../models/collaborator-end.ts", () => ({
  INVITATION_ACCEPTED_MAIL: "collaborator_invitation_accepted",
  INVITATION_DECLINED_MAIL: "collaborator_invitation_declined",
  destroyInvitationBang: mocks.destroyInvitation,
  deliverCollaboratorMail: mocks.deliver,
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
});

describe("POST /collaborators/incomings/:id/accept", () => {
  it("destroys the invitation, then mails the inviter", async () => {
    const result = await call(find("POST", "/collaborators/incomings/:id/accept"));
    expect(mocks.destroyInvitation).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith("collaborator_invitation_accepted", 7);
    expect(result).toEqual({
      status: 303,
      location: "/collaborators/incomings",
      flash: { notice: "Invitation accepted" },
    });
  });
});

describe("POST /collaborators/incomings/:id/decline", () => {
  it("hands the answer to Rails when ending the collaboration is refused before the write", async () => {
    mocks.endCollaboration.mockRejectedValue(new HandBackToRails("a product that would fail its own validation"));
    await expect(call(find("POST", "/collaborators/incomings/:id/decline"))).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("ends the collaboration, then mails the inviter", async () => {
    const result = await call(find("POST", "/collaborators/incomings/:id/decline"));
    expect(mocks.endCollaboration).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith("collaborator_invitation_declined", 7);
    expect(result).toEqual({
      status: 303,
      location: "/collaborators/incomings",
      flash: { notice: "Invitation declined" },
    });
  });
});

describe("DELETE /collaborators/incomings/:id", () => {
  const run = find("DELETE", "/collaborators/incomings/:id");

  it("answers not found for a collaboration that is gone", async () => {
    mocks.findAliveCollaborator.mockResolvedValue(null);
    await expect(call(run)).rejects.toBeInstanceOf(RoutingError);
  });

  it("removes the collaboration as the acting seller without looking for an invitation", async () => {
    const result = await run({
      routeParams: { id: "abc" },
      params: {},
      context: { currentSeller: { id: 4n } },
    } as unknown as MutationInput);
    expect(mocks.hasInvitation).not.toHaveBeenCalled();
    expect(mocks.destroyCollaboration).toHaveBeenCalledExactlyOnceWith(4n, 7);
    expect(result).toEqual({
      status: 303,
      location: "/collaborators/incomings",
      flash: { notice: "Collaborator removed" },
    });
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
