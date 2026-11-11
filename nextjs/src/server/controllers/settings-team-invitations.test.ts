import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors } from "../models/runtime/errors.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, sellerInvitationById, update, valid, build, markUndeleted } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  sellerInvitationById: vi.fn(),
  update: vi.fn(),
  valid: vi.fn(),
  build: vi.fn(),
  markUndeleted: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./json-seller.ts", async (original) => ({
  ...(await original<typeof import("./json-seller.ts")>()),
  sellerJsonAction: (_input: unknown, _policy: unknown, run: (context: unknown) => unknown) => run({}),
}));
vi.mock("../models/team-invitation.ts", () => ({
  sellerInvitationById,
  invitationById: vi.fn(),
  TeamInvitations: { update, valid, build },
  TeamInvitationDeletable: { markUndeleted, markDeletedBang: vi.fn() },
  isAccepted: vi.fn(),
  isDeleted: vi.fn(),
  isExpired: vi.fn(),
  matchesOwnerEmail: vi.fn(),
}));
vi.mock("../models/user.ts", async (original) => ({
  ...(await original<typeof import("../models/user.ts")>()),
  Users: { load: (row: unknown) => row },
  isAccountActive: (row: { active: boolean }) => row.active,
}));
vi.mock("../policies/settings/team-invitation.ts", () => ({
  settingsTeamInvitationPolicy: {
    create: () => true,
    update: () => true,
    destroy: () => true,
    restore: () => true,
    resendInvitation: () => true,
    accept: () => true,
  },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: () => 5 }));

await import("./settings-team-invitations.ts");

const INVITATION = "/settings/team/invitations/:id([A-Za-z0-9_=-]+).json";
const find = (method: string, pattern: string) =>
  specs.find((spec) => spec.method === method && spec.pattern === pattern)!;
const input = (params: Record<string, unknown>, active = true): MutationInput =>
  ({
    routeParams: { id: "abc" },
    params,
    context: { currentSeller: { id: 7n, email: "seller@example.com", active } },
  }) as unknown as MutationInput;

function invitationWith(email: string, message?: string) {
  const errors = new Errors();
  if (message) errors.add("email", message);
  return { get: () => email, errors };
}

beforeEach(() => {
  sellerInvitationById.mockReset().mockResolvedValue(invitationWith("invitee@example.com"));
  update.mockReset().mockResolvedValue(true);
  valid.mockReset();
  build.mockReset().mockReturnValue(invitationWith("new@example.com"));
  markUndeleted.mockReset();
});

describe("PUT /settings/team/invitations/:id", () => {
  const run = (mutation: MutationInput) => find("PUT", INVITATION).run(mutation);

  it("hands back a request without a team_invitation hash after authorizing it", async () => {
    await expect(run(input({}))).rejects.toBeInstanceOf(HandBackToRails);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", 7, "7"],
    ["null", null, null],
  ])("casts %s to the role it saves", async (_label, role, saved) => {
    await run(input({ team_invitation: { role } }));

    expect(update).toHaveBeenCalledWith(expect.anything(), { role: saved });
  });

  it("changes nothing for an array role, which permit drops", async () => {
    await run(input({ team_invitation: { role: ["admin"] } }));

    expect(update).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("answers the validation errors as a sentence with success false", async () => {
    update.mockResolvedValue(false);
    const invitation = invitationWith("invitee@example.com", "has already been invited");
    sellerInvitationById.mockResolvedValue(invitation);

    const result = (await run(input({ team_invitation: { role: "admin" } }))) as { status: number; body: string };

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: false, error_message: "Email has already been invited" });
  });

  it("answers 404 JSON for an invitation of another seller", async () => {
    sellerInvitationById.mockResolvedValue(null);

    const result = (await run(input({ team_invitation: { role: "admin" } }))) as { status: number; body: string };

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ success: false, error: "Not found" });
  });
});

describe("POST /settings/team/invitations.json", () => {
  const run = (mutation: MutationInput) => find("POST", "/settings/team/invitations.json").run(mutation);

  it("refuses an inactive seller before reading the params", async () => {
    const result = (await run(input({}, false))) as { status: number; body: string };

    expect(result.status).toBe(403);
    expect((JSON.parse(result.body) as { error_message: string }).error_message).toBe(
      "Your account can't send team invitations right now.",
    );
  });

  it("answers the validation failure without sending", async () => {
    valid.mockResolvedValue(false);
    build.mockReturnValue(invitationWith("nope", "is invalid"));

    const result = (await run(input({ team_invitation: { email: "nope", role: "admin" } }))) as { body: string };

    expect(JSON.parse(result.body)).toEqual({ success: false, error_message: "Email is invalid" });
  });

  it("hands back an invitation that validates, because sending it mails and takes the throttle", async () => {
    valid.mockResolvedValue(true);

    await expect(run(input({ team_invitation: { email: "new@example.com", role: "admin" } }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("hands back an email that is not text", async () => {
    await expect(run(input({ team_invitation: { email: 5, role: "admin" } }))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("PUT /settings/team/invitations/:id/resend_invitation.json", () => {
  const run = (mutation: MutationInput) =>
    find("PUT", "/settings/team/invitations/:id/resend_invitation.json").run(mutation);

  it("answers 422 for an invitation whose email is not an address", async () => {
    sellerInvitationById.mockResolvedValue(invitationWith("not-an-email"));

    const result = (await run(input({}))) as { status: number; body: string };

    expect(result.status).toBe(422);
    expect(JSON.parse(result.body)).toEqual({ success: false, error_message: "Email is invalid" });
  });

  it("hands back the resend of a valid invitation", async () => {
    await expect(run(input({}))).rejects.toBeInstanceOf(HandBackToRails);
  });
});
