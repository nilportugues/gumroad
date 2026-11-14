import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, type Chain } from "./application-controller.ts";

const { execute, selectRows, decrypt, findUser } = vi.hoisted(() => ({
  execute: vi.fn(),
  selectRows: vi.fn(),
  decrypt: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  execute,
  selectRows,
}));
vi.mock("../models/runtime/transaction.ts", () => ({ transaction: (fn: () => unknown) => fn() }));
vi.mock("../models/secure-external-id.ts", () => ({ decryptSecureExternalPayload: decrypt }));
vi.mock("../models/user.ts", () => ({ findUser }));

const { FEATURE_ANNOUNCEMENT_OPTIONS, unsubscribeProps } = await import("./feature-announcements.ts");

const NOW = new Date("2026-11-11T12:00:00Z");
const chainFor = (method: string, headers: Record<string, string> = {}) =>
  ({
    headers: new Headers(),
    now: NOW,
    request: { method, path: "/users/unsubscribe_feature_announcements/token", headers: new Headers(headers) },
  }) as unknown as Chain;
const run = (chain: Chain) => FEATURE_ANNOUNCEMENT_OPTIONS.filters!(chain);
const sqlText = (call: unknown[]) => {
  const statement = call[0] as { strings: string[] };
  return statement.strings.join("?");
};

beforeEach(() => {
  for (const mock of [execute, selectRows, decrypt, findUser]) mock.mockReset();
  decrypt.mockReturnValue([5, "digest"]);
  findUser.mockResolvedValue({ id: 5 });
  selectRows.mockResolvedValue([{ "@@SESSION.innodb_lock_wait_timeout": 50 }]);
  execute.mockResolvedValue(1);
});

describe("Users::FeatureAnnouncementsController#unsubscribe", () => {
  it("upserts the tombstone and restores the session lock wait for an Inertia POST", async () => {
    await expect(run(chainFor("POST", { "x-inertia": "true" }))).resolves.toEqual({ state: { unsubscribed: true } });

    const statements = execute.mock.calls.map(sqlText);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("innodb_lock_wait_timeout = 10");
    expect(statements[1]).toContain("ON DUPLICATE KEY UPDATE");
    expect(statements[2]).toContain("innodb_lock_wait_timeout = 50");
  });

  it("answers the 404 of an unknown token without writing", async () => {
    findUser.mockResolvedValue(null);

    const outcome = await run(chainFor("POST", { "x-inertia": "true" }));

    expect(outcome).toMatchObject({ halt: { status: 404 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands a POST without the Inertia header back before any write", async () => {
    await expect(run(chainFor("POST"))).rejects.toBeInstanceOf(HandBackToRails);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the request back when the row lock times out", async () => {
    execute
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(Object.assign(new Error("lock wait timeout"), { errno: 1205 }))
      .mockResolvedValue(0);

    await expect(run(chainFor("POST", { "x-inertia": "true" }))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("changes nothing for the GET confirmation", async () => {
    await expect(run(chainFor("GET"))).resolves.toEqual({ state: {} });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("unsubscribeProps", () => {
  it("drops the URL once unsubscribed", () => {
    expect(unsubscribeProps("tok", { unsubscribed: true })).toEqual({ unsubscribe_url: null, unsubscribed: true });
    expect(unsubscribeProps("tok", {})).toEqual({
      unsubscribe_url: "/users/unsubscribe_feature_announcements/tok",
      unsubscribed: false,
    });
  });
});
