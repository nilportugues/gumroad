import { createHash } from "node:crypto";

import type { MarketingAction } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { marketingActionPolicy } from "../policies/marketing-action.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import {
  applyCopyApproval,
  cancel,
  MAX_COPY_LENGTH,
  MarketingActions,
  marketingActionJson,
  marketingEnabledFor,
} from "./marketing-action.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { setSqlClient } from "./sql.ts";

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "marketing-action-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";
});

const action = (overrides: Partial<MarketingAction> = {}) =>
  MarketingActions.load({
    id: 7n,
    user_id: 3n,
    link_id: 5n,
    utm_link_id: null,
    channel: "x",
    status: "recommended",
    idempotency_key: "3:5:x:abcd",
    copy: "Launch: a fresh start.",
    external_post_id: null,
    external_url: null,
    error_code: null,
    approved_at: null,
    queued_at: null,
    posted_at: null,
    reconnect_notified_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

describe("Marketing::Action approval", () => {
  it("approves a recommended action and stamps approved_at", async () => {
    const db = fakeDatabase();
    const record = action();

    expect(await applyCopyApproval(record, {})).toBe("approved");

    expect(db.committed).toEqual([
      {
        model: "marketingAction",
        op: "update",
        id: 7n,
        data: expect.objectContaining({ status: "approved", approved_at: expect.any(Date) }),
      },
    ]);
  });

  it("writes the new copy with the approval in one update", async () => {
    const db = fakeDatabase();

    expect(await applyCopyApproval(action(), { copy: "Edited" })).toBe("approved");

    expect(db.committed).toHaveLength(1);
    expect(db.committed[0]!.data).toMatchObject({ copy: "Edited", status: "approved" });
  });

  it("approves an approved action again and moves approved_at", async () => {
    const db = fakeDatabase();
    const record = action({ status: "approved", approved_at: new Date("2026-01-02T00:00:00Z") });

    expect(await applyCopyApproval(record, {})).toBe("approved");

    expect(db.committed[0]!.data!.approved_at).not.toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  it.each(["queued", "posted"])("leaves a %s action as it is", async (status) => {
    const db = fakeDatabase();

    expect(await applyCopyApproval(action({ status }), { copy: "Edited" })).toBe("claimed");

    expect(db.writes).toEqual([]);
  });

  it.each(["cancelled", "failed", "blocked"])("closes a %s action", async (status) => {
    const db = fakeDatabase();

    expect(await applyCopyApproval(action({ status }), {})).toBe("closed");

    expect(db.writes).toEqual([]);
  });

  it("reports blank and null copy as invalid without a write", async () => {
    const db = fakeDatabase();
    const blank = action();
    const empty = action();

    expect(await applyCopyApproval(blank, { copy: "   " })).toBe("invalid");
    expect(await applyCopyApproval(empty, { copy: null })).toBe("invalid");

    expect(blank.errors.fullMessages()).toEqual(["Copy can't be blank"]);
    expect(db.writes).toEqual([]);
  });

  it("counts copy in characters, not bytes or UTF-16 units", async () => {
    fakeDatabase();
    const longest = action();
    const tooLong = action();

    expect(await applyCopyApproval(longest, { copy: "é".repeat(MAX_COPY_LENGTH) })).toBe("approved");
    expect(await applyCopyApproval(tooLong, { copy: "😀".repeat(MAX_COPY_LENGTH + 1) })).toBe("invalid");
    expect(tooLong.errors.fullMessages()).toEqual([`Copy is too long (maximum is ${MAX_COPY_LENGTH} characters)`]);
  });

  it("does not validate when the copy is unchanged", async () => {
    const db = fakeDatabase();
    const record = action();

    await applyCopyApproval(record, { copy: "Launch: a fresh start." });

    expect(db.queries.filter(({ sql }) => sql.includes("idempotency_key"))).toHaveLength(1);
  });
});

describe("Marketing::Action cancellation", () => {
  it.each(["recommended", "approved"])("cancels a %s action", async (status) => {
    const db = fakeDatabase();

    expect(await cancel(action({ status }))).toBe(true);

    expect(db.committed[0]!.data).toMatchObject({ status: "cancelled" });
  });

  it.each(["queued", "posted", "cancelled", "blocked"])("refuses to cancel a %s action", async (status) => {
    const db = fakeDatabase();

    expect(await cancel(action({ status }))).toBe(false);

    expect(db.writes).toEqual([]);
  });
});

describe("Marketing::Action#as_json", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  function answering(rows: Record<string, unknown[]>) {
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) =>
        rows[Object.keys(rows).find((table) => query.sql.includes(`\`${table}\``)) ?? ""] ?? []) as never,
      $executeRaw: (async () => 0) as never,
    }));
  }

  it("hashes the idempotency key and signs the post text with the seller's handle", async () => {
    answering({ utm_links: [{ permalink: "launch01" }], users: [{ twitter_handle: "marketer" }] });

    const json = await marketingActionJson(
      action({ utm_link_id: 9n, approved_at: new Date("2026-02-03T04:05:06.789Z") }),
    );

    expect(json).toMatchObject({
      idempotency_key: sha("3:5:x:abcd"),
      post_text: expect.stringMatching(/^Launch: a fresh start\.\n\nhttps?:\/\/.+\/u\/launch01$/u),
      approved_at: "2026-02-03T04:05:06Z",
      posted_at: null,
    });
    expect(json.confirmation_token).toBe(sha(JSON.stringify(["3:5:x:abcd", json.post_text, "marketer"])));
    expect(json.link_url).toBe((json.post_text as string).split("\n\n")[1]);
  });

  it("escapes HTML in the token's JSON as Rails' to_json does", async () => {
    answering({ users: [{ twitter_handle: null }] });

    const json = await marketingActionJson(action({ copy: "Fish & <chips>" }));

    expect(json.link_url).toBeNull();
    expect(json.confirmation_token).toBe(sha('["3:5:x:abcd","Fish \\u0026 \\u003cchips\\u003e",null]'));
  });
});

describe("Marketing::Eligibility.enabled_for?", () => {
  it("hands back a seller without a holdout assignment, which Rails would create", async () => {
    setSqlClient(() => ({ $queryRaw: (async () => []) as never, $executeRaw: (async () => 0) as never }));

    await expect(marketingEnabledFor({ id: 3n })).rejects.toThrow("not ported to Node yet");
  });

  it("is false for a held-out seller whatever the flag says", async () => {
    setSqlClient(() => ({
      $queryRaw: (async () => [{ marketing_holdout: 1 }]) as never,
      $executeRaw: (async () => 0) as never,
    }));

    expect(await marketingEnabledFor({ id: 3n })).toBe(false);
  });
});

describe("Marketing::ActionPolicy", () => {
  const seller = { id: 3n } as never;
  const member = (role: string, owner = false): SellerContext => {
    const user = owner ? seller : ({ id: 4n } as never);
    return { user, seller, memberships: owner ? [] : [{ seller_id: 3n, user_id: 4n, role } as never] };
  };

  it.each([
    ["admin", true],
    ["marketing", true],
    ["support", false],
    ["accountant", false],
  ] as const)("grants index to a %s member: %s", (role, allowed) => {
    expect(marketingActionPolicy.index(member(role))).toBe(allowed);
  });

  it("grants the owner everything on their own action", () => {
    expect(marketingActionPolicy.show(member("owner", true), { user_id: 3n })).toBe(true);
  });

  it("refuses an action that belongs to another user even for an admin", () => {
    expect(marketingActionPolicy.cancel(member("admin"), { user_id: 99n })).toBe(false);
  });
});
