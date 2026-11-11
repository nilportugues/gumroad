import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors, RecordInvalid } from "../models/runtime/errors.ts";

import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, sellerMembershipById, updateBang, markUndeletedBang } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  sellerMembershipById: vi.fn(),
  updateBang: vi.fn(),
  markUndeletedBang: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", async (original) => ({
  ...(await original<typeof import("./json-seller.ts")>()),
  sellerJsonAction: (_input: unknown, _policy: unknown, run: (context: unknown) => unknown) => run({}),
}));
vi.mock("../models/team-membership.ts", () => ({
  sellerMembershipById,
  TeamMemberships: { updateBang },
  TeamMembershipDeletable: { markUndeletedBang, markDeletedBang: vi.fn() },
}));
vi.mock("../policies/settings/team-membership.ts", () => ({
  settingsTeamMembershipPolicy: { update: () => true, destroy: () => true, restore: () => true },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: () => 5 }));

await import("./settings-team-mutations.ts");

const MEMBER = "/settings/team/members/:id([A-Za-z0-9_=-]+).json";
const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
const input = (params: Record<string, unknown>): MutationInput =>
  ({
    routeParams: { id: "abc" },
    params,
    context: { currentSeller: { id: 7n, email: "seller@example.com" } },
  }) as unknown as MutationInput;

function invalid(attribute: string, message: string): RecordInvalid {
  const errors = new Errors();
  errors.add(attribute, message);
  return new RecordInvalid(errors);
}

beforeEach(() => {
  sellerMembershipById.mockReset().mockResolvedValue({ attributes: {} });
  updateBang.mockReset();
  markUndeletedBang.mockReset();
});

describe("PUT /settings/team/members/:id", () => {
  const update = find("PUT", MEMBER);

  it("lets the RecordInvalid of a role outside the team roles reach the 422 page", async () => {
    updateBang.mockRejectedValue(invalid("role", "is not included in the list"));

    await expect(update.run(input({ team_membership: { role: "chief" } }))).rejects.toBeInstanceOf(RecordInvalid);
    expect(updateBang).toHaveBeenCalledWith(expect.anything(), { role: "chief" });
  });

  it.each([
    ["a number", 7, "7"],
    ["a boolean", true, "true"],
    ["null", null, null],
  ])("casts %s to the role it saves and lets the validation fail", async (_label, role, saved) => {
    updateBang.mockRejectedValue(invalid("role", "is not included in the list"));

    await expect(update.run(input({ team_membership: { role } }))).rejects.toBeInstanceOf(RecordInvalid);
    expect(updateBang).toHaveBeenCalledWith(expect.anything(), { role: saved });
  });

  it("changes nothing for an array role, which permit drops", async () => {
    updateBang.mockResolvedValue(undefined);

    const result = await update.run(input({ team_membership: { role: ["admin"] } }));

    expect((result as { status: number }).status).toBe(200);
    expect(updateBang).toHaveBeenCalledWith(expect.anything(), {});
  });
});

describe("PUT /settings/team/members/:id/restore.json", () => {
  it("lets the RecordInvalid of a membership the member has joined again reach the 422 page", async () => {
    markUndeletedBang.mockRejectedValue(invalid("seller", "has already been taken"));

    await expect(find("PUT", "/settings/team/members/:id/restore.json").run(input({}))).rejects.toBeInstanceOf(
      RecordInvalid,
    );
  });
});
