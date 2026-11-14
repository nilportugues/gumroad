import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  findAliveCollaborator: vi.fn(),
  guardRedirect: vi.fn(),
  allowed: vi.fn(),
  destroy: vi.fn(),
  resolve: vi.fn(),
  create: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "unknown" ? null : 7) }));
vi.mock("../models/collaborator-create.ts", () => ({
  resolveCreation: mocks.resolve,
  createCollaboration: mocks.create,
}));
vi.mock("../models/collaborator-end.ts", () => ({
  INVITED_MAIL: "collaborator_invited",
  CREATION_MAIL: "collaborator_creation",
  deliverCollaboratorMail: mocks.deliver,
}));
vi.mock("./collaborator-destroy.ts", () => ({ destroyCollaboration: mocks.destroy }));
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

  describe("POST /collaborators", () => {
    const create = (collaborator: unknown) =>
      run(
        "POST",
        "/collaborators",
      )({
        routeParams: {},
        params: { collaborator },
        context: { currentSeller: { id: 4n } },
      } as unknown as MutationInput);
    const body = {
      email: "ada@example.com",
      apply_to_all_products: true,
      percent_commission: "30",
      products: [{ id: "p1" }],
    };

    it.each([
      ["a missing collaborator hash", undefined],
      ["an empty collaborator hash", {}],
      ["an email that is a number", { ...body, email: 5 }],
      ["a flag that is a string", { ...body, apply_to_all_products: "false" }],
      ["a commission with a decimal", { ...body, percent_commission: "30.5" }],
      ["a negative commission", { ...body, percent_commission: -3 }],
      ["products that are a hash", { ...body, products: { 0: { id: "p1" } } }],
      ["a product id that is a number", { ...body, products: [{ id: 5 }] }],
    ])("hands %s back to Rails before reading anything", async (_name, collaborator) => {
      await expect(create(collaborator)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it("reads a commission sent as digits, and a blank one as none", async () => {
      mocks.resolve.mockResolvedValue({ blocked: "x" });
      await expect(create({ ...body, percent_commission: " " })).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.resolve).toHaveBeenCalledWith(
        4n,
        expect.objectContaining({ percent: null, products: [{ externalId: "p1", percent: null, dontShow: false }] }),
      );
      await expect(create(body)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.resolve).toHaveBeenLastCalledWith(4n, expect.objectContaining({ percent: 30 }));
    });

    it("hands back what the model cannot decide", async () => {
      mocks.resolve.mockResolvedValue({ blocked: "a commission outside the allowed range" });
      await expect(create(body)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it("redirects to the new form with the service's message and errors", async () => {
      mocks.resolve.mockResolvedValue({ message: "Product not found" });
      expect(await create(body)).toEqual({
        status: 302,
        location: "/collaborators/new",
        flash: { alert: "Product not found" },
        inertiaErrors: { "collaborator.base": "Product not found" },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it.each([
      [true, "collaborator_invited"],
      [false, "collaborator_creation"],
    ])("saves, then mails the invitation only when one was created (invited: %s)", async (invited, mail) => {
      mocks.resolve.mockResolvedValue({ invited });
      mocks.create.mockResolvedValue(12);
      expect(await create(body)).toEqual({
        status: 303,
        location: "/collaborators",
        flash: { notice: "Changes saved!" },
      });
      expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(mail, 12);
    });
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

  it("removes the collaboration as the acting seller once the policy passes", async () => {
    const result = await run(
      "DELETE",
      "/collaborators/:id",
    )({
      routeParams: { id: "abc" },
      context: { currentSeller: { id: 4n } },
    } as unknown as MutationInput);
    expect(mocks.destroy).toHaveBeenCalledExactlyOnceWith(4n, 7);
    expect(result).toEqual({
      status: 303,
      location: "/collaborators",
      flash: { notice: "The collaborator was removed successfully." },
    });
  });

  it("lets the policy refusal reach the guard", async () => {
    mocks.allowed.mockReturnValue(false);
    await expect(call(run("DELETE", "/collaborators/:id"))).rejects.toThrow("not authorized");
  });
});
