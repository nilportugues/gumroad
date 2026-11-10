// No MySQL is available to these tests: the database is a fake transaction client that answers
// the statements User issues from seeded rows and records every write, so the assertions are on
// the rows and statements Rails would write. Validation messages and normalisations are compared
// with user.golden.json, recorded from user.rb's own declarations (scripts/golden/user.rb).
import { readFileSync } from "node:fs";

import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { domainConfig } from "../infra/domain.ts";

import type { JobsRuntime } from "../jobs/runtime.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import { rubyJsonParse } from "./concerns/serialized-columns.ts";
import { currentTransaction, setTransactionRunner, type Tx } from "./runtime/transaction.ts";
import { setSqlClient } from "./sql.ts";
import {
  isBlockedUsername,
  isDisposableEmail,
  isReservedEmailDomain,
  isValidEmailFormat,
  KINDLE_EMAIL_REGEX,
  mailAddressDomain,
  normalizeGmailAddress,
  NotPortedError,
  resetUserCollaborators,
  rubyStrip,
  setJsonDataForAttr,
  setUserCollaborators,
  strippedField,
  enableRefundsBang,
  UserFlags,
  Users,
  type UserRecord,
} from "./user.ts";

type GoldenCase = {
  name: string;
  existing_id: number | null;
  persist_first: Record<string, YamlValue> | null;
  assign: Record<string, YamlValue>;
  result: {
    errors: { attribute: string; type: string | null; message: string }[];
    full_messages: string[];
    attributes: Record<string, string | null>;
    json_data: string | null;
    changed: string[];
  };
};

type Golden = {
  existing: { id: number; email: string; username: string; deleted_at: string | null; is_team_member: number; confirmed_at: string | null; json_data: string | null }[];
  platform_blocks: { object_type: string; object_value: string; active: boolean }[];
  gmail_abuse: string[];
  cases: GoldenCase[];
  stripped_fields: { input: string; stripped: string | null; ruby_strip: string }[];
  custom_fee_per_thousand: { value: YamlValue; messages: string[] }[];
  emails: { email: string; email_format: boolean; kindle: boolean; reserved_domain: boolean | null; mail_domain: string | null; disposable: boolean; gmail_normalized: string | null }[];
  usernames: { username: string; email: string | null; blocked: boolean }[];
};

// Parsed the way Ruby's JSON does, so 5.0 stays a Float.
const plain = (value: YamlValue): unknown =>
  value instanceof RubyHash ? Object.fromEntries(value.entries.map(([k, v]) => [k, plain(v)])) : Array.isArray(value) ? value.map(plain) : value;
const golden = plain(rubyJsonParse(readFileSync(new URL("./__fixtures__/user.golden.json", import.meta.url), "utf8"))) as Golden;
const goldenRaw = rubyJsonParse(readFileSync(new URL("./__fixtures__/user.golden.json", import.meta.url), "utf8")) as { [k: string]: YamlValue };

// ---------------------------------------------------------------------------------------------
// Fake database

type Row = Record<string, unknown>;
type Statement = { sql: string; values: unknown[] };
type Write = { model: string; op: "create" | "update" | "delete"; id: unknown; data?: Row };
type Handler = [RegExp, (values: unknown[]) => Row[]];

class FakeMysql {
  writes: Write[] = [];
  committed: Write[] = [];
  statements: Statement[] = [];
  handlers: Handler[] = [];
  nextId = 100;
  tx: Tx;

  constructor() {
    const delegate = (model: string) => ({
      create: async ({ data }: { data: Row }) => {
        const id = data.id ?? BigInt(this.nextId++);
        this.writes.push({ model, op: "create", id, data });
        return { ...data, id };
      },
      update: async ({ where, data }: { where: { id: unknown }; data: Row }) => {
        this.writes.push({ model, op: "update", id: where.id, data });
        return { ...data, id: where.id };
      },
      delete: async ({ where }: { where: { id: unknown } }) => {
        this.writes.push({ model, op: "delete", id: where.id });
        return { id: where.id };
      },
    });
    const query = async (statement: Statement) => {
      this.statements.push({ sql: statement.sql, values: statement.values });
      const handler = this.handlers.find(([pattern]) => pattern.test(statement.sql));
      return handler ? handler[1](statement.values) : [];
    };
    this.tx = new Proxy({} as Tx, {
      get: (_, prop: string) => {
        if (prop === "$queryRaw") return query;
        if (prop === "$executeRaw") return async (s: Statement) => (await query(s), 1);
        return delegate(prop);
      },
    });
    setTransactionRunner(async (fn) => {
      const before = this.writes.length;
      try {
        const result = await fn(this.tx);
        this.committed.push(...this.writes.slice(before));
        return result;
      } catch (error) {
        this.writes.splice(before);
        throw error;
      }
    });
  }

  on(pattern: RegExp, fn: (values: unknown[]) => Row[]): this {
    this.handlers.push([pattern, fn]);
    return this;
  }

  sql(pattern: RegExp): Statement[] {
    return this.statements.filter((s) => pattern.test(s.sql));
  }
}

type Enqueued = { jobClass: string; args: unknown[]; options?: unknown; inTransaction: boolean };

let db: FakeMysql;
let enqueued: Enqueued[];

beforeEach(() => {
  db = new FakeMysql();
  setSqlClient(() => db.tx as never);
  enqueued = [];
  setUserCollaborators({
    enqueue: async (jobClass, args, options) => {
      enqueued.push({ jobClass, args, ...(options ? { options } : {}), inTransaction: currentTransaction() !== null });
      return "jid";
    },
    enqueueBulk: async (jobClass, argsList) => {
      for (const args of argsList) enqueued.push({ jobClass, args, inTransaction: currentTransaction() !== null });
    },
    sismember: async (_, member) => (golden.gmail_abuse.includes(member) ? 1 : 0),
    isFeatureEnabled: async () => false,
    pwnedCount: async () => 0,
    now: () => new Date("2026-10-31T12:00:00.123Z"),
    readDb: async () => db.tx,
    randomExternalId: () => "4242",
    friendlyToken: () => "friendly-token",
    otpSecret: () => "OTPSECRET",
  });
});

afterEach(() => resetUserCollaborators());

// A users row as Prisma returns it, with the columns' defaults.
function userRow(attributes: Partial<User>): User {
  const defaults = Users.build().attributes as User;
  return { ...defaults, recommendation_type: "own_products", user_risk_state: "compliant", external_id: "1001", ...attributes } as User;
}

// ---------------------------------------------------------------------------------------------
// Golden: validations and normalisations

function seedGoldenDatabase(overrides: Record<number, Row> = {}) {
  const rows = golden.existing.map((r) => ({ ...r, ...overrides[r.id] }));
  db.on(/FROM `users` WHERE `users`.`username` = BINARY/u, ([value, exceptId]) =>
    rows.filter((r) => r.username === value && (exceptId === undefined || BigInt(r.id) !== exceptId)).map(() => ({ one: 1 })),
  );
  db.on(/FROM `users` WHERE `users`.`email` = /u, ([value]) => rows.filter((r) => r.email === value).map((r) => ({ deleted_at: r.deleted_at })));
  db.on(/FROM `platform_blocks`/u, ([, value, type]) =>
    golden.platform_blocks.filter((b) => b.active && b.object_value === value && b.object_type === type).map(() => ({ id: 1 })),
  );
  return rows;
}

function loadGoldenUser(row: Golden["existing"][number] & Row): UserRecord {
  return Users.load(
    userRow({
      id: BigInt(row.id),
      email: row.email,
      username: row.username,
      name: (row.name as string | undefined) ?? null,
      deleted_at: row.deleted_at ? new Date(`${row.deleted_at}Z`) : null,
      confirmed_at: row.confirmed_at ? new Date(`${row.confirmed_at}Z`) : null,
      flags: UserFlags.set(1n, "is_team_member", row.is_team_member === 1),
      json_data: row.json_data,
    }),
  );
}

const JSON_DATA_ATTRIBUTES = ["custom_fee_per_thousand", "payout_frequency", "tiktok_pixel_id"];

function assign(record: UserRecord, attributes: Record<string, YamlValue>) {
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "password" || key === "password_confirmation") record.ivars[key] = value;
    else if (JSON_DATA_ATTRIBUTES.includes(key)) setJsonDataForAttr(record, key, value);
    else record.set(key as keyof User & string, value as never);
  }
}

describe("User validations and normalisations (golden)", () => {
  // Rails' state machine sets user_risk_state, which the golden model has no column for.
  const NOT_IN_GOLDEN_MODEL = ["user_risk_state"];

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_, testCase) => {
    const rows = seedGoldenDatabase(testCase.persist_first && testCase.existing_id ? { [testCase.existing_id]: testCase.persist_first } : {});
    const record = testCase.existing_id === null ? Users.build() : loadGoldenUser(rows.find((r) => r.id === testCase.existing_id)!);
    const caseRaw = (goldenRaw.cases as YamlValue[]).find((c) => (c as { name: string }).name === testCase.name) as { assign: YamlValue };
    assign(record, Object.fromEntries((caseRaw.assign as RubyHash).entries ?? Object.entries(caseRaw.assign as object)) as Record<string, YamlValue>);

    await Users.valid(record);
    const appendHttp = Users.definition.beforeSave!.find((cb) => cb.name === "append_http")!;
    await appendHttp.run(record, { tx: db.tx });

    expect(record.errors.details.map((d) => ({ attribute: d.attribute, message: d.message }))).toEqual(
      testCase.result.errors.map((e) => ({ attribute: e.attribute, message: e.message })),
    );
    expect(record.errors.fullMessages()).toEqual(testCase.result.full_messages);
    for (const [attribute, value] of Object.entries(testCase.result.attributes)) {
      expect([attribute, record.get(attribute as keyof User & string)]).toEqual([attribute, value]);
    }
    expect(record.get("json_data")).toBe(testCase.result.json_data);
    expect(record.changedAttributeNames().filter((a) => !NOT_IN_GOLDEN_MODEL.includes(a)).sort()).toEqual(testCase.result.changed);
  });

  it.each(golden.custom_fee_per_thousand.map((c, i) => [String(i), c] as const))("custom_fee_per_thousand vector %s", async (index, vector) => {
    seedGoldenDatabase();
    const record = Users.build({ email: "new@example.com" });
    assign(record, { password: "secret-password" });
    const raw = ((goldenRaw.custom_fee_per_thousand as YamlValue[])[Number(index)] as RubyHash | { value: YamlValue });
    const value = raw instanceof RubyHash ? raw.entries.find(([k]) => k === "value")![1] : raw.value;
    setJsonDataForAttr(record, "custom_fee_per_thousand", value);
    await Users.valid(record);
    expect(record.errors.on("custom_fee_per_thousand")).toEqual(vector.messages);
  });

  it.each(golden.stripped_fields.map((v) => [JSON.stringify(v.input), v] as const))("strips %s as StrippedFields and String#strip do", (_, vector) => {
    expect(strippedField(vector.input)).toBe(vector.stripped);
    expect(rubyStrip(vector.input)).toBe(vector.ruby_strip);
  });

  it.each(golden.emails.map((v) => [JSON.stringify(v.email), v] as const))("classifies the email %s as the Ruby validators do", (_, vector) => {
    expect(isValidEmailFormat(vector.email)).toBe(vector.email_format);
    expect(KINDLE_EMAIL_REGEX.test(vector.email)).toBe(vector.kindle);
    expect(isReservedEmailDomain(vector.email)).toBe(Boolean(vector.reserved_domain));
    expect(mailAddressDomain(vector.email)).toBe(vector.mail_domain === "ParseError" ? "parse_error" : vector.mail_domain);
    expect(isDisposableEmail(vector.email)).toBe(vector.disposable);
    expect(normalizeGmailAddress(vector.email)).toBe(vector.gmail_normalized);
  });

  it.each(golden.usernames.map((v) => [`${v.username} / ${v.email}`, v] as const))("blocks the username %s as BlockedUsernameValidator does", (_, vector) => {
    expect(isBlockedUsername(vector.username, vector.email)).toBe(vector.blocked);
  });

  it("ships the disposable domain list from lib/data", () => {
    const source = readFileSync(new URL("../../../../lib/data/disposable_email_domains.txt", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    for (const domain of source) expect(isDisposableEmail(`someone@${domain}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Saves: rows, statements and jobs

const versions = () => db.committed.filter((w) => w.model === "version").map((w) => w.data!);
const userWrites = () => db.committed.filter((w) => w.model === "user");

function existingSeller(attributes: Partial<User> = {}): UserRecord {
  return Users.load(
    userRow({
      id: 7n,
      email: "seller@example.com",
      username: "seller",
      confirmed_at: new Date("2024-01-01T00:00:00Z"),
      json_data: '{"payout_frequency":"weekly"}',
      ...attributes,
    }),
  );
}

describe("Users.save on an existing seller", () => {
  it("re-enables refunds, invalidating each product's cache and versioning the flag change", async () => {
    db.on(/SELECT `links`.`id` FROM `links`/u, () => [{ id: 11n }, { id: 12n }]);
    const user = existingSeller({ flags: UserFlags.set(1n, "refunds_disabled", true) });

    await enableRefundsBang(user);

    expect(userWrites()).toHaveLength(1);
    expect(Object.keys(userWrites()[0]!.data!).sort()).toEqual(["flags", "updated_at"]);
    expect(userWrites()[0]!.data!.flags).toBe(1n);
    expect(versions().map((v) => v.event)).toEqual(["update"]);
    expect(enqueued).toEqual([
      { jobClass: "InvalidateProductCacheWorker", args: [11n], inTransaction: true },
      { jobClass: "InvalidateProductCacheWorker", args: [12n], inTransaction: true },
    ]);
    // Neither email, confirmation, deletion, risk state nor the announcement bit moved.
    expect(db.sql(/feature_announcement_newsletter_cutovers/u)).toEqual([]);
  });

  it("writes {} into a NULL json_data, as reading it in validation does in Rails", async () => {
    const user = existingSeller({ json_data: null });
    await Users.updateBang(user, { name: "New name" });
    expect(userWrites()[0]!.data).toMatchObject({ name: "New name", json_data: "{}" });
    // merge_json_data_with_current_row read the row under a lock and found it NULL.
    expect(db.sql(/SELECT `users`.`json_data` FROM `users` WHERE `users`.`id` = \? LIMIT 1 FOR UPDATE/u)).toHaveLength(1);
  });

  it("rebases its json_data delta onto keys another request wrote meanwhile", async () => {
    db.on(/SELECT `users`.`json_data` FROM `users`/u, () => [{ json_data: '{"payout_frequency":"weekly","gumroad_day_timezone":"UTC"}' }]);
    const user = existingSeller();
    setJsonDataForAttr(user, "payouts_paused_by", "admin");
    await Users.saveBang(user);
    expect(userWrites()[0]!.data!.json_data).toBe('{"payout_frequency":"weekly","gumroad_day_timezone":"UTC","payouts_paused_by":"admin"}');
  });

  it("strips a string TikTok pixel id before validation", async () => {
    const user = existingSeller({ json_data: '{"payout_frequency":"weekly"}' });
    setJsonDataForAttr(user, "tiktok_pixel_id", " ABC123 ");
    await Users.saveBang(user);
    expect(JSON.parse(userWrites()[0]!.data!.json_data as string).tiktok_pixel_id).toBe("ABC123");
  });

  it("raises NoMethodError on an integer TikTok pixel id, which has no #strip, and writes nothing", async () => {
    const user = existingSeller({ json_data: '{"payout_frequency":"weekly"}' });
    setJsonDataForAttr(user, "tiktok_pixel_id", 1234567890);
    await expect(Users.saveBang(user)).rejects.toMatchObject({ name: "NoMethodError", message: "undefined method 'strip' for an instance of Integer" });
    expect(userWrites()).toEqual([]);
  });

  it("schedules the Stripe and subscribe-preview jobs a username change needs, in Rails' order", async () => {
    const user = existingSeller();
    await Users.updateBang(user, { username: "newname" });

    expect(enqueued.map(({ jobClass, args, inTransaction }) => [jobClass, args, inTransaction])).toEqual([
      ["CreateStripeApplePayDomainWorker", [7n], true],
      ["DeleteStripeApplePayDomainWorker", [7n, `seller.${domainConfig().rootDomain}`], true],
      ["GenerateSubscribePreviewJob", [7n], false],
      ["SyncStripeBusinessProfileUrlJob", [7n], false],
    ]);
  });

  it("sends Devise's email-changed and reconfirmation mails through Sidekiq as deliver_later does", async () => {
    // Records what rawPushToSidekiq writes; mail/active-job.test.ts pins the payload bytes.
    const pushes: { score: string; payload: Record<string, unknown>; inTransaction: boolean }[] = [];
    const pipeline = {
      zadd(_key: string, score: string, payload: string) {
        pushes.push({ score, payload: JSON.parse(payload) as Record<string, unknown>, inTransaction: currentTransaction() !== null });
        return pipeline;
      },
      exec: async () => [],
    };
    const runtime = { now: () => 1793448000.5, newJid: () => "jid", sidekiqRedis: { pipeline: () => pipeline } } as unknown as JobsRuntime;
    const user = existingSeller({ confirmation_token: "old" });

    await withJobsRuntime(runtime, () => Users.updateBang(user, { email: "other@example.com" }));

    const mails = pushes.map(({ payload, score, inTransaction }) => {
      const job = (payload.args as Record<string, unknown>[])[0]!;
      return { queue: payload.queue, score, arguments: job.arguments, inTransaction };
    });
    expect(mails).toEqual([
      {
        queue: "critical",
        score: "1793448003.5",
        arguments: ["UserSignupMailer", "email_changed", "deliver_now", { args: [{ _aj_globalid: "gid://gumroad/User/7" }, { to: "seller@example.com", _aj_symbol_keys: ["to"] }], _aj_ruby2_keywords: ["args"] }],
        // Devise's after_update callback: Ruby enqueues it inside the transaction.
        inTransaction: true,
      },
      {
        queue: "critical",
        score: "1793448003.5",
        arguments: [
          "UserSignupMailer",
          "confirmation_instructions",
          "deliver_now",
          { args: [{ _aj_globalid: "gid://gumroad/User/7" }, "friendly-token", { to: "other@example.com", _aj_symbol_keys: ["to"] }], _aj_ruby2_keywords: ["args"] },
        ],
        inTransaction: false,
      },
    ]);
  });

  it("postpones an email change into unconfirmed_email with a fresh confirmation token", async () => {
    const mails: unknown[] = [];
    setUserCollaborators({ sendDeviseNotification: async (_, notification, args) => void mails.push([notification, args]) });
    const user = existingSeller({ confirmation_token: "old" });
    await Users.updateBang(user, { email: "other@example.com" });

    expect(userWrites()[0]!.data).toMatchObject({ unconfirmed_email: "other@example.com", confirmation_token: "friendly-token", confirmation_sent_at: new Date("2026-10-31T12:00:00Z") });
    expect(userWrites()[0]!.data).not.toHaveProperty("email");
    expect(mails).toEqual([
      ["email_changed", { to: "seller@example.com" }],
      ["confirmation_instructions", { token: "friendly-token", to: "other@example.com" }],
    ]);
    expect(enqueued.map((e) => [e.jobClass, e.options])).toEqual([["ReindexSubscriptionCurrentEmailWorker", { delaySeconds: 10 }]]);
  });

  it("moves purchases to an email changed without reconfirmation, after commit", async () => {
    db.on(/FROM `purchases` WHERE `purchases`.`purchaser_id`/u, () => [{ one: 1 }]);
    db.on(/SELECT `users`.`id` FROM `users` WHERE `users`.`external_id`/u, () => [{ id: 1n }]);
    db.on(/SELECT `followers`.`id`/u, () => [{ id: 55n }]);
    const user = existingSeller({ confirmed_at: null });
    user.ivars.bypass_confirmation_postpone = true;
    await Users.updateBang(user, { email: "other@example.com" });

    expect(userWrites()[0]!.data).toMatchObject({ email: "other@example.com" });
    // Reverse declaration order: move_purchases_to_new_email, then reindex_subscription_current_email.
    expect(enqueued.map((e) => [e.jobClass, e.args, e.options, e.inTransaction])).toEqual([
      ["UpdatePurchaseEmailToMatchAccountWorker", [7n], { delaySeconds: 10 }, false],
      ["ReindexSubscriptionCurrentEmailWorker", [7n], { delaySeconds: 10 }, false],
    ]);
    // fence_newsletter_cutover locked the follows at both addresses and touched them.
    expect(db.sql(/SELECT `followers`.`id`/u)[0]!.values).toEqual([1n, "seller@example.com", "other@example.com"]);
    expect(db.sql(/^UPDATE `followers`/u)[0]!.values).toEqual([new Date("2026-10-31T12:00:00Z"), 55n]);
  });

  it("hands the seller's products to the product index update", async () => {
    // products.find_each
    db.on(/SELECT `links`.\* FROM `links`/u, () => [{ id: 11n }]);
    const updates: [bigint[], string[]][] = [];
    setUserCollaborators({ enqueueProductIndexUpdates: async (_user, ids, changeList) => void updates.push([ids, changeList]) });
    const user = existingSeller();
    await Users.updateBang(user, { name: "Renamed" });
    expect(updates).toEqual([[[11n], ["rated_as_adult", "creator_name"]]]);
  });

  it("clears the reset password token when the password changes", async () => {
    const user = existingSeller({ reset_password_token: "digest", reset_password_sent_at: new Date("2026-10-30T00:00:00Z") });
    user.ivars.password = "new-password-123";
    user.ivars.password_confirmation = "new-password-123";
    user.set("encrypted_password", "$2a$new");
    await Users.saveBang(user);
    expect(userWrites()[0]!.data).toMatchObject({ reset_password_token: null, reset_password_sent_at: null, encrypted_password: "$2a$new" });
  });
});

describe("Users.create", () => {
  const signup = { email: "new@example.com", encrypted_password: "$2a$hash" };

  it("is refused before any write while GlobalAffiliate is not ported", async () => {
    const user = Users.build(signup);
    user.ivars.password = "secret-password";
    await expect(Users.saveBang(user)).rejects.toBeInstanceOf(NotPortedError);
    expect(db.committed).toEqual([]);
  });

  it("inserts the row Rails would, then hands off to the unported collaborators and jobs", async () => {
    const calls: string[] = [];
    setUserCollaborators({
      createGlobalAffiliate: async () => void calls.push("global_affiliate"),
      createRefundPolicy: async () => void calls.push("refund_policy"),
      sendDeviseNotification: async (_, notification) => void calls.push(notification),
    });
    const user = Users.build(signup);
    user.ivars.password = "secret-password";
    await Users.saveBang(user);

    const insert = userWrites()[0]!;
    expect(insert.op).toBe("create");
    expect(insert.data).toMatchObject({
      email: "new@example.com",
      external_id: "4242",
      confirmation_token: "friendly-token",
      confirmation_sent_at: new Date("2026-10-31T12:00:00Z"),
      otp_secret_key: "OTPSECRET",
      recommendation_type: "own_products",
      user_risk_state: "not_reviewed",
      json_data: "{}",
    });
    for (const flag of ["enable_payment_email", "two_factor_authentication_enabled", "tipping_enabled", "discover_boost_enabled", "product_page_storefront_enabled", "refund_fee_notice_shown"] as const) {
      expect(UserFlags.isSet(insert.data!.flags as bigint, flag)).toBe(true);
    }
    expect(UserFlags.isSet(insert.data!.flags as bigint, "refund_policy_enabled")).toBe(false);
    expect(versions().map((v) => v.event)).toEqual(["create"]);
    expect(versions()[0]!.object_changes).not.toContain("otp_secret_key");
    // after_create, then after_commit in reverse declaration order.
    expect(calls).toEqual(["global_affiliate", "refund_policy", "confirmation_instructions"]);
    expect(enqueued.map((e) => [e.jobClass, e.inTransaction])).toEqual([
      ["GenerateSubscribePreviewJob", false],
      ["GenerateUsernameJob", false],
    ]);
  });

  it("draws another external id when the first is taken", async () => {
    setUserCollaborators({ createGlobalAffiliate: async () => undefined, createRefundPolicy: async () => undefined, sendDeviseNotification: async () => undefined });
    const ids = ["1", "2"];
    setUserCollaborators({ randomExternalId: () => ids.shift()! });
    db.on(/FROM `users` WHERE `users`.`external_id` = /u, ([candidate]) => (candidate === "1" ? [{ id: 1n }] : []));
    const user = Users.build({ ...signup, confirmed_at: new Date("2026-10-31T00:00:00Z") });
    user.ivars.password = "secret-password";
    await Users.saveBang(user);
    expect(user.get("external_id")).toBe("2");
  });

  it("leaves two-factor off when the caller skips it", async () => {
    setUserCollaborators({ createGlobalAffiliate: async () => undefined, createRefundPolicy: async () => undefined, sendDeviseNotification: async () => undefined });
    const user = Users.build(signup);
    user.ivars.password = "secret-password";
    user.ivars.skip_enabling_two_factor_authentication = true;
    await Users.saveBang(user);
    expect(UserFlags.isSet(user.get("flags"), "two_factor_authentication_enabled")).toBe(false);
  });
});
