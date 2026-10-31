import type { Follower } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { defineModel } from "../runtime/define-model";
import { RecordInvalid } from "../runtime/errors";
import { fakeDatabase } from "../runtime/testing";
import { validatesPresenceOf } from "../runtime/validators";
import { alive, deletable, deleted } from "./deletable";

let db: ReturnType<typeof fakeDatabase>;
const seen: boolean[] = [];

const Followers = defineModel<Follower>({
  rubyClass: "Follower",
  prismaModel: "Follower",
  delegate: (tx) => tx.follower as never,
  validations: [validatesPresenceOf(["email"])],
  beforeSave: [{ name: "track", run: (r) => void seen.push(FollowerDeletable.beingMarkedAsDeleted(r)) }],
});
const FollowerDeletable = deletable(Followers);

beforeEach(() => {
  db = fakeDatabase();
  seen.length = 0;
});

describe("Deletable", () => {
  it("sets deleted_at truncated to the datetime(0) column and saves", async () => {
    const record = await Followers.createBang({ email: "a@example.com", followed_id: 1 });
    await FollowerDeletable.markDeletedBang(record, { now: () => new Date("2024-01-01T00:00:00.999Z") });

    expect(record.get("deleted_at")).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(FollowerDeletable.isDeleted(record)).toBe(true);
    expect(seen).toEqual([false, true]);
    expect(db.committed.at(-1)).toMatchObject({ op: "update", data: { deleted_at: new Date("2024-01-01T00:00:00Z") } });
  });

  it("skips validations only when asked, as account closure does", async () => {
    const record = await Followers.createBang({ email: "a@example.com", followed_id: 1 });
    record.set("email", "");
    await expect(FollowerDeletable.markDeletedBang(record)).rejects.toBeInstanceOf(RecordInvalid);
    await FollowerDeletable.markDeletedBang(record, { validate: false });
    expect(FollowerDeletable.isDeleted(record)).toBe(true);
  });

  it("undeletes", async () => {
    const record = await Followers.createBang({ email: "a@example.com", followed_id: 1, deleted_at: new Date() });
    expect(await FollowerDeletable.markUndeleted(record)).toBe(true);
    expect(FollowerDeletable.isAlive(record)).toBe(true);
  });

  it("exposes the alive and deleted scopes as where clauses", () => {
    expect(alive).toEqual({ deleted_at: null });
    expect(deleted).toEqual({ deleted_at: { not: null } });
  });
});
