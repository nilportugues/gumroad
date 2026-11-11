import { beforeEach, describe, expect, it, vi } from "vitest";

import { Errors } from "../models/runtime/errors.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const {
  specs,
  sellerInvitationById,
  update,
  valid,
  build,
  save,
  markUndeleted,
  checkSendThrottle,
  unreviewedLimitReached,
  reportInvitationBurst,
  deliverInvite,
  withLock,
} = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  sellerInvitationById: vi.fn(),
  update: vi.fn(),
  valid: vi.fn(),
  build: vi.fn(),
  save: vi.fn(),
  markUndeleted: vi.fn(),
  checkSendThrottle: vi.fn(),
  unreviewedLimitReached: vi.fn(),
  reportInvitationBurst: vi.fn(),
  deliverInvite: vi.fn(),
  withLock: vi.fn(),
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
  TeamInvitations: { update, valid, build, save },
  TeamInvitationDeletable: { markUndeleted, markDeletedBang: vi.fn() },
  singleMailboxEmail: (email: string) => email !== "not-an-email",
  isAccepted: vi.fn(),
  isDeleted: vi.fn(),
  isExpired: vi.fn(),
  matchesOwnerEmail: vi.fn(),
}));
vi.mock("../models/team-invitation-throttle.ts", () => ({
  UNREVIEWED_TOTAL_LIMIT: 3,
  checkSendThrottle,
  unreviewedLimitReached,
  reportInvitationBurst,
  deliverInvite,
  invitationExpiry: () => new Date("2026-11-18T23:59:59.999Z"),
  invitationLimitMessage: (name: string, limit: number, retryAfter: number) => `${limit}/${name} in ${retryAfter}`,
}));
vi.mock("../models/concerns/job-runtime.ts", () => ({
  afterCommitEverywhere: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../models/user.ts", async (original) => ({
  ...(await original<typeof import("../models/user.ts")>()),
  Users: { load: (row: unknown) => row, withLock },
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
    context: { currentSeller: { id: 7n, email: "seller@example.com", active, get: () => 7n } },
  }) as unknown as MutationInput;

function invitationWith(email: string, message?: string) {
  const errors = new Errors();
  if (message) errors.add("email", message);
  return { get: (name: string) => (name === "id" ? 42 : email), errors };
}

beforeEach(() => {
  sellerInvitationById.mockReset().mockResolvedValue(invitationWith("invitee@example.com"));
  update.mockReset().mockResolvedValue(true);
  valid.mockReset();
  build.mockReset().mockReturnValue(invitationWith("new@example.com"));
  save.mockReset().mockResolvedValue(true);
  markUndeleted.mockReset();
  checkSendThrottle.mockReset().mockResolvedValue(null);
  unreviewedLimitReached.mockReset().mockResolvedValue(false);
  reportInvitationBurst.mockReset().mockResolvedValue(undefined);
  deliverInvite.mockReset().mockResolvedValue(undefined);
  withLock.mockReset().mockImplementation((_seller: unknown, fn: () => unknown) => fn());
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

  const params = { team_invitation: { email: "new@example.com", role: "admin" } };
  const parse = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;

  it("saves a valid invitation under the seller lock and enqueues the mail", async () => {
    valid.mockResolvedValue(true);

    const result = await run(input(params));

    expect(parse(result)).toEqual({ success: true });
    expect(withLock).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(deliverInvite).toHaveBeenCalledWith(42);
  });

  it("sets the expiry on the invitation it builds", async () => {
    valid.mockResolvedValue(true);

    await run(input(params));

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ expires_at: new Date("2026-11-18T23:59:59.999Z") }));
  });

  it("refuses a seller suspended while the request was in flight, without saving", async () => {
    valid.mockResolvedValue(true);
    withLock.mockImplementation((seller: { active: boolean }, fn: () => unknown) => {
      seller.active = false;
      return fn();
    });

    const result = (await run(input(params))) as { status: number; rescued?: boolean };

    expect(result.status).toBe(403);
    expect(result.rescued).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(deliverInvite).not.toHaveBeenCalled();
  });

  it("answers the unreviewed cap as a failure with a 200 and reports the account window", async () => {
    valid.mockResolvedValue(true);
    unreviewedLimitReached.mockResolvedValue(true);

    const result = (await run(input(params))) as { status: number };

    expect(result.status).toBe(200);
    expect(parse(result)).toEqual({
      success: false,
      error_message:
        "New accounts can have up to 3 team invitations while the account is being reviewed. Please contact support if you need more.",
    });
    expect(reportInvitationBurst).toHaveBeenCalledWith(expect.anything(), { window: "account", limit: 3 });
    expect(checkSendThrottle).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After for a throttled seller and reports the burst", async () => {
    valid.mockResolvedValue(true);
    checkSendThrottle.mockResolvedValue({ window: "hour", limit: 10, retry_after: 120 });

    const result = (await run(input(params))) as { status: number; headers: Record<string, string> };

    expect(result.status).toBe(429);
    expect(result.headers).toEqual({ "Retry-After": "120" });
    expect(parse(result)).toEqual({ error: "10/hour in 120", retry_after: 120 });
    expect(reportInvitationBurst).toHaveBeenCalledWith(expect.anything(), {
      window: "hour",
      limit: 10,
      retry_after: 120,
    });
    expect(save).not.toHaveBeenCalled();
    expect(deliverInvite).not.toHaveBeenCalled();
  });

  it("answers the validation failure of the save and sends nothing", async () => {
    valid.mockResolvedValue(true);
    save.mockResolvedValue(false);
    build.mockReturnValue(invitationWith("new@example.com", "has already been invited"));

    const result = await run(input(params));

    expect(parse(result)).toEqual({ success: false, error_message: "Email has already been invited" });
    expect(deliverInvite).not.toHaveBeenCalled();
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

  it("reserves no send for an invitation whose email is refused", async () => {
    // The real singleMailboxEmail raises NotPortedError for it; the mock stands in with the same refusal.
    sellerInvitationById.mockResolvedValue(invitationWith("not-an-email"));

    await run(input({}));

    expect(checkSendThrottle).not.toHaveBeenCalled();
  });

  it("extends the expiry and enqueues the mail for a valid invitation", async () => {
    const invitation = invitationWith("invitee@example.com");
    sellerInvitationById.mockResolvedValue(invitation);

    const result = (await run(input({}))) as { body: string };

    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(update).toHaveBeenCalledWith(invitation, { expires_at: new Date("2026-11-18T23:59:59.999Z") });
    expect(deliverInvite).toHaveBeenCalledWith(42);
  });

  it("answers 429 for a throttled seller without touching the invitation", async () => {
    checkSendThrottle.mockResolvedValue({ window: "day", limit: 50, retry_after: 7200 });

    const result = (await run(input({}))) as { status: number; headers: Record<string, string> };

    expect(result.status).toBe(429);
    expect(result.headers).toEqual({ "Retry-After": "7200" });
    expect(update).not.toHaveBeenCalled();
    expect(deliverInvite).not.toHaveBeenCalled();
  });

  it("answers the validation failure of the update and sends nothing", async () => {
    update.mockResolvedValue(false);
    sellerInvitationById.mockResolvedValue(invitationWith("invitee@example.com", "is invalid"));

    const result = (await run(input({}))) as { body: string };

    expect(JSON.parse(result.body)).toEqual({ success: false, error_message: "Email is invalid" });
    expect(deliverInvite).not.toHaveBeenCalled();
  });
});
