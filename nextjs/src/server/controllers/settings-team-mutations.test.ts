import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors, RecordInvalid } from "../models/runtime/errors.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, sellerMembershipById, updateBang, markUndeletedBang, teamMemberInfos, markDeletedBang } = vi.hoisted(
  () => ({
    specs: [] as MutationSpec[],
    teamMemberInfos: vi.fn(),
    markDeletedBang: vi.fn(),
    sellerMembershipById: vi.fn(),
    updateBang: vi.fn(),
    markUndeletedBang: vi.fn(),
  }),
);

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
  TeamMembershipDeletable: { markUndeletedBang, markDeletedBang },
}));
vi.mock("../policies/settings/team-membership.ts", () => ({
  settingsTeamMembershipPolicy: { update: () => true, destroy: () => true, restore: () => true },
}));
vi.mock("../page-props/settings/presenter.ts", () => ({ teamMemberInfos }));
vi.mock("../policies/settings/team-user.ts", () => ({ settingsTeamUserPolicy: { show: () => true } }));
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
  markDeletedBang.mockReset();
  teamMemberInfos.mockReset();
});

describe("GET /settings/team/members.json", () => {
  it("answers the member infos of the seller's team", async () => {
    teamMemberInfos.mockResolvedValue([{ type: "owner" }]);

    const result = (await find("GET", "/settings/team/members.json").run(input({}))) as {
      status: number;
      body: string;
    };

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: true, member_infos: [{ type: "owner" }] });
  });
});

describe("DELETE /settings/team/members/:id", () => {
  const destroy = find("DELETE", MEMBER);

  it("hands the removal of a member of the Gumroad account to Rails before writing", async () => {
    const gumroad = input({});
    (gumroad.context.currentSeller as { email: string }).email = "hi@example.com";

    await expect(destroy.run(gumroad)).rejects.toBeInstanceOf(HandBackToRails);
    expect(markDeletedBang).not.toHaveBeenCalled();
  });
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

  it("hands a request without a team_membership hash to Rails before writing", async () => {
    await expect(update.run(input({}))).rejects.toBeInstanceOf(HandBackToRails);
    expect(updateBang).not.toHaveBeenCalled();
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
