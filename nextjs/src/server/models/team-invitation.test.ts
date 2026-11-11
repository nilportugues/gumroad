// spec/models/team_invitation_spec.rb (validations) and the writes of Settings::Team::InvitationsController.
import type { TeamInvitation } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { setAssociation } from "./concerns/rails-validations.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { matchesOwnerEmail, singleMailboxEmail, TeamInvitationDeletable, TeamInvitations } from "./team-invitation.ts";
import { NotPortedError } from "./user.ts";

const SELLER_ID = 1n;
const OWNER_EMAIL = "owner@example.com";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

let db: ReturnType<typeof fakeDatabase>;

// The seller is cached as loaded, so only the uniqueness and existing-member lookups query.
function invitation(attributes: Partial<TeamInvitation> = {}): ModelRecord<TeamInvitation> {
  const record = TeamInvitations.load({
    id: 5n,
    seller_id: SELLER_ID,
    email: "invitee@example.com",
    role: "admin",
    expires_at: CREATED_AT,
    accepted_at: null,
    deleted_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...attributes,
  } as TeamInvitation);
  setAssociation(record, "seller", SELLER_ID, { id: SELLER_ID, email: OWNER_EMAIL });
  return record;
}

beforeEach(() => {
  db = fakeDatabase();
});

describe("TeamInvitation validations", () => {
  it("is valid for a free email and a role from the list", async () => {
    db.queueQueryResults([], []);

    expect(await TeamInvitations.valid(invitation())).toBe(true);
  });

  it("lowercases and strips the email before validating", async () => {
    db.queueQueryResults([], []);
    const record = invitation({ email: "  Invitee@Example.COM " });

    await TeamInvitations.valid(record);

    expect(record.get("email")).toBe("invitee@example.com");
  });

  it("refuses the owner role and a missing role", async () => {
    db.queueQueryResults([], [], [], []);
    const owner = invitation({ role: "owner" });
    const missing = invitation({ role: null as unknown as string });

    expect(await TeamInvitations.valid(owner)).toBe(false);
    expect(await TeamInvitations.valid(missing)).toBe(false);
    expect(owner.errors.fullMessages()).toEqual(["Role is not included in the list"]);
    expect(missing.errors.fullMessages()).toEqual(["Role is not included in the list"]);
  });

  it("reports an email that is not an address once, without asking the mailbox parser", async () => {
    db.queueQueryResults([], []);
    const record = invitation({ email: "not-an-email" });

    expect(await TeamInvitations.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Email is invalid"]);
  });

  it("reports an email invited already", async () => {
    db.queueQueryResults([{ one: 1 }], []);
    const record = invitation();

    expect(await TeamInvitations.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Email has already been invited"]);
  });

  it.each([
    ["a live team member", [{ one: 1 }], "invitee@example.com"],
    ["the owner", [], OWNER_EMAIL],
  ])("reports the email of %s", async (_label, members, email) => {
    db.queueQueryResults([], members);
    const record = invitation({ email });

    expect(await TeamInvitations.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Email is associated with an existing team member"]);
  });

  it("skips the uniqueness, mailbox and member checks of a removed invitation", async () => {
    const record = invitation({ deleted_at: CREATED_AT, email: "not-an-email" });

    expect(await TeamInvitations.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Email is invalid"]);
    expect(db.queries).toEqual([]);
  });

  it("refuses to decide on a quoted mailbox, which Mail::AddressList has to parse", async () => {
    db.queueQueryResults([], []);

    await expect(TeamInvitations.valid(invitation({ email: '"quoted name"@example.com' }))).rejects.toBeInstanceOf(
      NotPortedError,
    );
  });
});

describe("singleMailboxEmail", () => {
  it("accepts a bare dot-atom mailbox and rejects what EMAIL_REGEX rejects", () => {
    expect(singleMailboxEmail("first.last+tag@sub.example.co")).toBe(true);
    expect(singleMailboxEmail("a@b")).toBe(false);
    expect(singleMailboxEmail("a@example.com, b@example.com")).toBe(false);
  });
});

describe("TeamInvitation state", () => {
  it("compares the invited email with the owner's email ignoring case", () => {
    expect(matchesOwnerEmail(invitation({ email: "owner@example.com" }), "Owner@Example.com")).toBe(true);
    expect(matchesOwnerEmail(invitation(), null)).toBe(false);
  });

  it("stamps deleted_at when removing and clears it when restoring", async () => {
    db.queueQueryResults([]);
    const record = invitation();

    await TeamInvitationDeletable.markDeletedBang(record);
    expect(record.get("deleted_at")).toBeInstanceOf(Date);

    db.queueQueryResults([], []);
    expect(await TeamInvitationDeletable.markUndeleted(record)).toBe(true);
    expect(record.get("deleted_at")).toBeNull();
  });
});
