import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors, RecordInvalid } from "../models/runtime/errors.ts";

import { HandBackToRails, ParameterMissing } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, sellerMembershipById, updateBang, markUndeletedBang, teamMemberInfos, markDeletedBang, findUser } =
  vi.hoisted(() => ({
    specs: [] as MutationSpec[],
    findUser: vi.fn(),
    teamMemberInfos: vi.fn(),
    markDeletedBang: vi.fn(),
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
  TeamMembershipDeletable: { markUndeletedBang, markDeletedBang },
}));
vi.mock("../models/user.ts", async (original) => ({
  ...(await original<typeof import("../models/user.ts")>()),
  findUser,
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
  sellerMembershipById.mockReset().mockResolvedValue({ attributes: {}, get: () => 9n });
  findUser.mockReset();
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

  const gumroadSeller = () => {
    const gumroad = input({});
    (gumroad.context.currentSeller as { email: string }).email = "hi@example.com";
    return gumroad;
  };
  // `User.flags` bit 28 is `is_team_member`.
  const memberWith = (flags: bigint) => ({ get: (name: string) => (name === "flags" ? flags : null) });

  it("hands the removal of a flagged team member of the Gumroad account to Rails before writing", async () => {
    findUser.mockResolvedValue(memberWith(1n << 27n));

    await expect(destroy.run(gumroadSeller())).rejects.toBeInstanceOf(HandBackToRails);
    expect(findUser).toHaveBeenCalledWith(9n);
    expect(markDeletedBang).not.toHaveBeenCalled();
  });

  it("hands the removal of a member who is gone to Rails", async () => {
    findUser.mockResolvedValue(null);

    await expect(destroy.run(gumroadSeller())).rejects.toBeInstanceOf(HandBackToRails);
    expect(markDeletedBang).not.toHaveBeenCalled();
  });

  it("removes a member of the Gumroad account who is not flagged, where Rails' user update changes nothing", async () => {
    findUser.mockResolvedValue(memberWith(0n));

    const result = (await destroy.run(gumroadSeller())) as { body: string };
    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(markDeletedBang).toHaveBeenCalledTimes(1);
  });

  it("does not read the member of an account other than the Gumroad account's", async () => {
    await destroy.run(input({}));
    expect(findUser).not.toHaveBeenCalled();
    expect(markDeletedBang).toHaveBeenCalledTimes(1);
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

  it("answers a request without a team_membership key with a 400 before writing", async () => {
    await expect(update.run(input({}))).rejects.toBeInstanceOf(ParameterMissing);
    expect(updateBang).not.toHaveBeenCalled();
  });

  it("hands back an empty team_membership hash, which no recording covers", async () => {
    await expect(update.run(input({ team_membership: {} }))).rejects.toBeInstanceOf(HandBackToRails);
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
