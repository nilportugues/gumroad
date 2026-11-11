import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findAliveCollaborator: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "unknown" ? null : 7) }));
vi.mock("../page-props/dashboard/collaborators.ts", () => ({ findAliveCollaborator: mocks.findAliveCollaborator }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../policies/authorize.ts", () => ({
  authorize: (query: (...args: unknown[]) => boolean) => {
    if (!query()) throw new Error("not authorized");
  },
}));
vi.mock("../policies/collaborator.ts", () => ({
  collaboratorPolicy: { create: () => mocks.allowed(), update: () => mocks.allowed(), destroy: () => mocks.allowed() },
}));
vi.mock("../page-props/audience/seller-guard.ts", () => ({
  sellerGuard: async (_input: unknown, step: (context: unknown) => unknown) => {
    if (mocks.guardRedirect()) return mocks.guardRedirect();
    await step({});
    return null;
  },
}));

await import("./collaborators-main-mutations.ts");

const run = (method: string, pattern: string) =>
  mocks.specs.find((spec) => spec.method === method && spec.pattern === pattern)!.run;
const call = (spec: MutationSpec["run"], id = "abc") => spec({ routeParams: { id } } as unknown as MutationInput);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findAliveCollaborator.mockResolvedValue({ id: 7, seller_id: 1 });
  mocks.allowed.mockReturnValue(true);
});

describe("Collaborators::MainController", () => {
  it("registers PUT next to PATCH for an update", () => {
    expect(mocks.specs.map((spec) => `${spec.method} ${spec.pattern}`)).toEqual([
      "POST /collaborators",
      "PATCH /collaborators/:id",
      "PUT /collaborators/:id",
      "DELETE /collaborators/:id",
    ]);
  });

  it("hands a create back to Rails once the policy passes", async () => {
    await expect(call(run("POST", "/collaborators"))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("returns the guard redirect for a create", async () => {
    mocks.guardRedirect.mockReturnValue({ status: 302, location: "/login" });
    expect(await call(run("POST", "/collaborators"))).toEqual({ status: 302, location: "/login" });
  });

  it("answers 404 before the sign-in check for an id that does not decrypt", async () => {
    await expect(call(run("PATCH", "/collaborators/:id"), "unknown")).rejects.toBeInstanceOf(RoutingError);
    expect(mocks.guardRedirect).not.toHaveBeenCalled();
  });

  it("answers 404 for an ended collaboration", async () => {
    mocks.findAliveCollaborator.mockResolvedValue(null);
    await expect(call(run("DELETE", "/collaborators/:id"))).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands an update back to Rails once the policy passes", async () => {
    await expect(call(run("PATCH", "/collaborators/:id"))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a removal back to Rails once the policy passes", async () => {
    await expect(call(run("DELETE", "/collaborators/:id"))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("lets the policy refusal reach the guard", async () => {
    mocks.allowed.mockReturnValue(false);
    await expect(call(run("DELETE", "/collaborators/:id"))).rejects.toThrow("not authorized");
  });
});
