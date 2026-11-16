// spec/models/team_membership_spec.rb (validations) and the writes of Settings::Team::MembersController.
import type { TeamMembership } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { setAssociation } from "./concerns/rails-validations.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { TeamMembershipDeletable, TeamMemberships } from "./team-membership.ts";

const SELLER_ID = 1n;
const USER_ID = 2n;
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

let db: ReturnType<typeof fakeDatabase>;

// The user and the seller are cached as loaded, so only the uniqueness and owner lookups query.
function membership(attributes: Partial<TeamMembership> = {}): ModelRecord<TeamMembership> {
  const record = TeamMemberships.load({
    id: 5n,
    seller_id: SELLER_ID,
    user_id: USER_ID,
    role: "marketing",
    last_accessed_at: null,
    deleted_at: CREATED_AT,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...attributes,
  } as TeamMembership);
  setAssociation(record, "user", record.get("user_id"), { id: record.get("user_id") });
  setAssociation(record, "seller", record.get("seller_id"), { id: record.get("seller_id") });
  return record;
}

beforeEach(() => {
  db = fakeDatabase();
});

describe("TeamMembership validations", () => {
  it("is valid for a role of a user who has an owner membership", async () => {
    db.nextQueryResult([{ role: "owner" }]);

    expect(await TeamMemberships.valid(membership())).toBe(true);
  });

  it("requires a role from the list", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    const record = membership({ role: "billing" });

    expect(await TeamMemberships.valid(record)).toBe(false);
    expect(record.errors.on("role")).toEqual(["is not included in the list"]);
  });

  it("requires the user to have an owner membership first", async () => {
    db.nextQueryResult([]);
    const record = membership();

    expect(await TeamMemberships.valid(record)).toBe(false);
    expect(record.errors.on("user_id")).toEqual(["requires owner membership to be created first"]);
  });

  it("refuses a user with two owner memberships", async () => {
    db.nextQueryResult([{ role: "owner" }, { role: "owner" }]);

    expect(await TeamMemberships.valid(membership())).toBe(false);
  });

  it("refuses a second live membership of the same user on the seller", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    const record = membership({ deleted_at: null });

    expect(await TeamMemberships.valid(record)).toBe(false);
    expect(record.errors.on("seller")).toEqual(["has already been taken"]);
    expect(record.errors.fullMessages()).toEqual(["Seller has already been taken"]);
  });

  it("does not look for duplicates of a deleted membership", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    await TeamMemberships.valid(membership());

    expect(db.queries.some((query) => query.sql.includes("`deleted_at` IS NULL"))).toBe(false);
  });

  it("assigns the owner role only to the seller's own membership", async () => {
    const record = membership({ role: "owner" });

    expect(await TeamMemberships.valid(record)).toBe(false);
    expect(record.errors.on("seller_id")).toEqual(["must match user for owner role"]);
  });

  it("accepts the owner role on the seller's own membership", async () => {
    expect(await TeamMemberships.valid(membership({ role: "owner", user_id: SELLER_ID }))).toBe(true);
  });

  it("refuses any other role on the seller's own membership", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    const record = membership({ user_id: SELLER_ID });

    expect(await TeamMemberships.valid(record)).toBe(false);
    expect(record.errors.on("role")).toEqual(["cannot be assigned to owner's membership"]);
  });
});

describe("TeamMembership writes", () => {
  it("refuses to restore a membership when the user has a live one on the seller", async () => {
    db.queueQueryResults([{ id: 9 }], [{ role: "owner" }]);

    await expect(TeamMembershipDeletable.markUndeletedBang(membership())).rejects.toBeInstanceOf(RecordInvalid);
    expect(db.committed).toEqual([]);
  });

  it("changes the role of a membership and nothing else", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    const now = new Date("2026-02-02T00:00:00.000Z");

    await TeamMemberships.updateBang(membership(), { role: "admin" }, { now: () => now });

    expect(db.committed.filter((write) => write.model === "teamMembership")).toEqual([
      expect.objectContaining({ op: "update", id: 5n, data: { role: "admin", updated_at: now } }),
    ]);
  });

  it("raises RecordInvalid for an unknown role and writes nothing", async () => {
    db.nextQueryResult([{ role: "owner" }]);

    await expect(TeamMemberships.updateBang(membership(), { role: "billing" })).rejects.toBeInstanceOf(RecordInvalid);
    expect(db.committed).toEqual([]);
  });

  it("marks a membership deleted (update_as_deleted!) at the column's precision", async () => {
    db.nextQueryResult([{ role: "owner" }]);
    const now = new Date("2026-02-02T03:04:05.678Z");

    await TeamMembershipDeletable.markDeletedBang(membership({ deleted_at: null }), { now: () => now });

    const update = db.committed.find((write) => write.model === "teamMembership" && write.op === "update");
    expect(update?.data).toMatchObject({ deleted_at: new Date("2026-02-02T03:04:05.000Z") });
  });

  it("restores a deleted membership (update_as_not_deleted!)", async () => {
    // The duplicate lookup of a live membership comes first, then the user's memberships.
    db.queueQueryResults([], [{ role: "owner" }]);

    await TeamMembershipDeletable.markUndeletedBang(membership());

    const update = db.committed.find((write) => write.model === "teamMembership" && write.op === "update");
    expect(update?.data).toMatchObject({ deleted_at: null });
  });
});
