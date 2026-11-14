import type { Follower } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { defineModel, type Callback } from "./define-model.ts";
import { abort, RecordInvalid } from "./errors.ts";
import { fakeDatabase } from "./testing.ts";
import { transaction } from "./transaction.ts";
import { validatesPresenceOf } from "./validators.ts";

let db: ReturnType<typeof fakeDatabase>;
let log: string[];

const trace = (name: string, extra: Partial<Callback<Follower>> = {}): Callback<Follower> => ({ name, run: () => void log.push(name), ...extra });

function model(overrides: Partial<Parameters<typeof defineModel<Follower>>[0]> = {}) {
  return defineModel<Follower>({
    rubyClass: "Follower",
    prismaModel: "Follower",
    delegate: (tx) => tx.follower as never,
    beforeValidation: [trace("before_validation")],
    validations: [trace("validate"), validatesPresenceOf(["email"])],
    afterValidation: [trace("after_validation")],
    beforeSave: [trace("before_save")],
    beforeCreate: [trace("before_create")],
    beforeUpdate: [trace("before_update")],
    afterCreate: [trace("after_create")],
    afterUpdate: [trace("after_update")],
    afterSave: [trace("after_save")],
    beforeDestroy: [trace("before_destroy")],
    afterDestroy: [trace("after_destroy")],
    afterCommit: [trace("after_commit_1"), trace("after_create_commit", { on: "create" }), trace("after_commit_3")],
    afterRollback: [trace("after_rollback")],
    ...overrides,
  });
}

beforeEach(() => {
  db = fakeDatabase();
  log = [];
});

describe("defineModel lifecycle", () => {
  it("runs create callbacks in Rails order, with after_commit reversed and after the transaction", async () => {
    const Followers = model({ afterCreate: [{ name: "after_create", run: () => void log.push(`after_create writes=${db.committed.length}`) }] });
    const record = await Followers.create({ email: "a@example.com", followed_id: 1 });

    expect(log).toEqual([
      "before_validation",
      "validate",
      "after_validation",
      "before_save",
      "before_create",
      "after_create writes=0",
      "after_save",
      "after_commit_3",
      "after_create_commit",
      "after_commit_1",
    ]);
    expect(record.persisted).toBe(true);
    expect(record.get("id")).toBe(1);
    expect(db.committed).toHaveLength(1);
  });

  it("sets created_at/updated_at truncated to the column precision before before_create", async () => {
    let seen: Date | null = null;
    const Followers = model({ beforeCreate: [{ name: "peek", run: (r) => void (seen = r.get("created_at")) }] });
    await Followers.create({ email: "a@example.com", followed_id: 1 }, { now: () => new Date("2024-05-06T07:08:09.987Z") });
    expect(seen).toEqual(new Date("2024-05-06T07:08:09.000Z"));
    expect(db.writes[0]!.data).toMatchObject({ created_at: new Date("2024-05-06T07:08:09Z"), updated_at: new Date("2024-05-06T07:08:09Z") });
  });

  it("inserts every column (partial_inserts off) and exposes saved_changes in after_create", async () => {
    let saved: string[] = [];
    const Followers = model({ afterCreate: [{ name: "peek", run: (r) => void (saved = Object.keys(r.savedChanges)) }] });
    await Followers.create({ email: "a@example.com", followed_id: 1 });
    expect(Object.keys(db.writes[0]!.data!)).toEqual(["followed_id", "email", "created_at", "updated_at", "follower_user_id", "source", "source_product_id", "confirmed_at", "deleted_at"]);
    expect(saved).toEqual(["id", "followed_id", "email", "created_at", "updated_at"]);
  });

  it("updates only changed columns and touches updated_at only when something changed", async () => {
    const Followers = model();
    const record = Followers.load({ id: 5, followed_id: 1, email: "a@example.com", created_at: null, updated_at: null, follower_user_id: null, source: null, source_product_id: null, confirmed_at: null, deleted_at: null });

    await Followers.save(record, { now: () => new Date("2024-01-01T00:00:00Z") });
    expect(db.writes).toEqual([]);
    expect(log).toContain("after_commit_1");
    expect(log).not.toContain("after_create_commit");

    await Followers.update(record, { source: "profile" }, { now: () => new Date("2024-01-01T00:00:00Z") });
    expect(db.writes).toEqual([{ model: "follower", op: "update", id: 5, data: { updated_at: new Date("2024-01-01T00:00:00Z"), source: "profile" } }]);
  });

  it("returns false, rolls back and runs after_rollback when validation fails", async () => {
    const Followers = model();
    const record = Followers.build({ followed_id: 1 });
    expect(await Followers.save(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Email can't be blank"]);
    expect(log).toEqual(["before_validation", "validate", "after_validation", "after_rollback"]);
    await expect(Followers.saveBang(record)).rejects.toThrow(new RecordInvalid(record.errors).message);
  });

  it("skips validation callbacks with validate: false", async () => {
    const Followers = model();
    expect(await Followers.save(Followers.build({ followed_id: 1 }), { validate: false })).toBe(true);
    expect(log.slice(0, 2)).toEqual(["before_save", "before_create"]);
  });

  it("rolls back writes made before a callback aborts", async () => {
    const Followers = model({ beforeCreate: [{ name: "abort", run: () => abort() }], beforeSave: [{ name: "side effect", run: (_, { tx }) => (tx as never as { gift: { create: (a: unknown) => Promise<unknown> } }).gift.create({ data: {} }) }] });
    const record = Followers.build({ email: "a@example.com", followed_id: 1 });
    expect(await Followers.save(record)).toBe(false);
    expect(record.newRecord).toBe(true);
    expect(db.committed).toEqual([]);
    expect(log).toEqual(["before_validation", "validate", "after_validation", "after_rollback"]);
  });

  it("joins an outer transaction and defers after_commit until it commits, once per record", async () => {
    const Followers = model();
    await transaction(async () => {
      const record = await Followers.create({ email: "a@example.com", followed_id: 1 });
      await Followers.update(record, { source: "x" });
      expect(log.filter((l) => l.startsWith("after_commit"))).toEqual([]);
    });
    expect(db.transactions).toBe(1);
    // First save in the transaction was a create, so only the create-commit chain ran.
    expect(log.filter((l) => l.includes("commit"))).toEqual(["after_commit_3", "after_create_commit", "after_commit_1"]);
  });

  it("runs destroy callbacks and commit callbacks for on: destroy", async () => {
    const Followers = model({ afterCommit: [trace("after_destroy_commit", { on: "destroy" })] });
    const record = Followers.load({ id: 9, followed_id: 1, email: "a@example.com", created_at: null, updated_at: null, follower_user_id: null, source: null, source_product_id: null, confirmed_at: null, deleted_at: null });
    await Followers.destroy(record);
    expect(log).toEqual(["before_destroy", "after_destroy", "after_destroy_commit"]);
    expect(db.writes).toEqual([{ model: "follower", op: "delete", id: 9 }]);
    expect(record.destroyed).toBe(true);
  });
  it("runs the validations a context does not exclude and skips on: create/update ones under a custom context", async () => {
    const failing = (name: string, extra: Partial<Callback<Follower>> = {}): Callback<Follower> => ({
      name,
      run: (record) => void (log.push(`${name} context=${record.validationContext}`), record.errors.add("base", name)),
      ...extra,
    });
    const Followers = model({
      beforeValidation: [],
      validations: [
        failing("always"),
        failing("not_expiring", { unless: (record) => record.validationContext === "expiring" }),
        failing("only_on_update", { on: "update" }),
      ],
      afterValidation: [],
    });
    const record = Followers.load({ id: 5, followed_id: 1, email: "a@example.com", created_at: null, updated_at: null, follower_user_id: null, source: null, source_product_id: null, confirmed_at: null, deleted_at: null });

    expect(await Followers.save(record, { context: "expiring" })).toBe(false);
    expect(log.filter((l) => l.includes("context="))).toEqual(["always context=expiring"]);
    expect(record.validationContext).toBeNull();

    log.length = 0;
    expect(await Followers.save(record)).toBe(false);
    expect(log.filter((l) => l.includes("context="))).toEqual(["always context=update", "not_expiring context=update", "only_on_update context=update"]);
  });
});
