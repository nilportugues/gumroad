import type { OauthAccessToken, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";

import { RpcSession } from "./server.ts";
import { toolBody, ToolRpcError, type PayoutReader, type PayoutRow } from "./tool-bodies.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws19-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const user = (attributes: Partial<User> = {}) =>
  ({
    id: 7,
    external_id: "ext123==",
    name: "Ada Seller",
    username: "ada_seller",
    currency_type: "eur",
    ...attributes,
  }) as User;
const token = (scopes: string) => ({ scopes }) as OauthAccessToken;

const payout = (id: number, createdAt: string, attributes: Partial<PayoutRow> = {}): PayoutRow => ({
  id: BigInt(id),
  amount_cents: 12_345n,
  currency: "usd",
  state: "completed",
  created_at: new Date(createdAt),
  ...attributes,
});

const context = (scopes: string, payouts?: PayoutReader, owner = user()) => ({
  user: owner,
  token: token(scopes),
  payouts,
});

describe("get_account", () => {
  it("returns the profile with the storefront url on the username subdomain", async () => {
    const body = await toolBody("get_account", {}, context("view_profile"));

    expect(body).toEqual({
      id: "ext123==",
      name: "Ada Seller",
      username: "ada_seller",
      url: expect.stringMatching(/^https?:\/\/ada-seller\./u),
      currency: "eur",
    });
  });

  it("falls back to the external id when the seller has no username", async () => {
    const body = await toolBody("get_account", {}, context("account", undefined, user({ username: null })));

    expect(body).toMatchObject({ username: "ext123==" });
  });

  it.each(["view_profile", "view_public", "view_sales", "account"])("accepts the %s scope", async (scope) => {
    await expect(toolBody("get_account", {}, context(scope))).resolves.toBeDefined();
  });

  it("hands back to Rails when no accepted scope is held", async () => {
    await expect(toolBody("get_account", {}, context("edit_products view_payouts"))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});

describe("list_payouts", () => {
  it("returns payouts newest first with the wire fields and no cursor on the last page", async () => {
    const reader = vi
      .fn<PayoutReader>()
      .mockResolvedValue([payout(5, "2026-03-02T10:00:00Z"), payout(4, "2026-03-01T10:00:00Z", { state: null })]);

    const body = await toolBody("list_payouts", {}, context("view_payouts", reader));

    expect(reader).toHaveBeenCalledWith(7n, 11, null);
    expect(body).toEqual({
      payouts: [
        {
          id: expect.any(String),
          amount_cents: 12_345,
          currency: "usd",
          state: "completed",
          created_at: "2026-03-02T10:00:00Z",
        },
        {
          id: expect.any(String),
          amount_cents: 12_345,
          currency: "usd",
          state: null,
          created_at: "2026-03-01T10:00:00Z",
        },
      ],
    });
    expect(body).not.toHaveProperty("next_cursor");
  });

  it("fetches one extra row and returns a cursor from the last row of the page", async () => {
    const reader = vi
      .fn<PayoutReader>()
      .mockResolvedValue([
        payout(9, "2026-03-03T00:00:00Z"),
        payout(8, "2026-03-02T00:00:00Z"),
        payout(7, "2026-03-01T00:00:00Z"),
      ]);

    const body = await toolBody("list_payouts", { limit: 2 }, context("account", reader));

    expect(reader).toHaveBeenCalledWith(7n, 3, null);
    expect((body!.payouts as unknown[]).length).toBe(2);
    expect(body!.next_cursor).toBe(`${Date.parse("2026-03-02T00:00:00Z") * 1000}_8`);
  });

  it("passes a cursor to the reader as microsecond datetime and id", async () => {
    const reader = vi.fn<PayoutReader>().mockResolvedValue([]);

    await toolBody("list_payouts", { cursor: "1772323200000000_8" }, context("view_payouts", reader));

    expect(reader).toHaveBeenCalledWith(7n, 11, { at: "2026-03-01 00:00:00.000000", id: 8n });
  });

  it("keeps the microseconds of a hand-made cursor", async () => {
    const reader = vi.fn<PayoutReader>().mockResolvedValue([]);

    await toolBody("list_payouts", { cursor: "1772323200000123_8" }, context("view_payouts", reader));

    expect(reader).toHaveBeenCalledWith(7n, 11, { at: "2026-03-01 00:00:00.000123", id: 8n });
  });

  it("ignores a blank cursor", async () => {
    const reader = vi.fn<PayoutReader>().mockResolvedValue([]);

    await toolBody("list_payouts", { cursor: "  " }, context("view_payouts", reader));

    expect(reader).toHaveBeenCalledWith(7n, 11, null);
  });

  it.each(["abc", "123", "12_x", "_5", "12_", "-1_5", "1\n_5"])("refuses the malformed cursor %j", async (cursor) => {
    const reader = vi.fn<PayoutReader>();

    await expect(toolBody("list_payouts", { cursor }, context("view_payouts", reader))).rejects.toMatchObject({
      message: "cursor is not valid",
      code: -32602,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("refuses a cursor past year 9999", async () => {
    await expect(
      toolBody("list_payouts", { cursor: "253402300800000000_1" }, context("account", vi.fn())),
    ).rejects.toBeInstanceOf(ToolRpcError);
  });

  it("accepts a cursor in the last second of year 9999", async () => {
    const reader = vi.fn<PayoutReader>().mockResolvedValue([]);

    await toolBody("list_payouts", { cursor: "253402300799000000_1" }, context("account", reader));

    expect(reader).toHaveBeenCalledWith(7n, 11, { at: "9999-12-31 23:59:59.000000", id: 1n });
  });

  it.each([0, 51, -3])("refuses the limit %i", async (limit) => {
    await expect(toolBody("list_payouts", { limit }, context("account", vi.fn()))).rejects.toMatchObject({
      message: "limit must be between 1 and 50",
      code: -32602,
    });
  });

  it("hands back to Rails without the payouts scope", async () => {
    await expect(toolBody("list_payouts", {}, context("view_profile", vi.fn()))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});

describe("toolBody", () => {
  it("leaves a tool that is not ported to Rails", async () => {
    await expect(toolBody("list_sales", {}, context("account"))).resolves.toBeUndefined();
  });
});

describe("tools/call through the session", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const session = (scopes: string) =>
    new RpcSession(
      { protocolVersion: null, method: null, name: null },
      async () => false,
      context(scopes, vi.fn<PayoutReader>().mockResolvedValue([])),
    );

  it("wraps the payload as pretty JSON text and structured content", async () => {
    const reply = (await session("account").handle(call("list_payouts", {}))) as {
      result: { content: { type: string; text: string }[]; structuredContent: unknown };
    };

    expect(reply.result.structuredContent).toEqual({ payouts: [] });
    expect(reply.result.content).toEqual([{ type: "text", text: '{\n  "payouts": []\n}' }]);
  });

  it("answers a limit error as a JSON-RPC error", async () => {
    const reply = await session("account").handle(call("list_payouts", { limit: 99 }));

    expect(reply).toMatchObject({ error: { code: -32602, message: "limit must be between 1 and 50" } });
  });

  it("still hands back a tool that is not ported", async () => {
    await expect(session("account").handle(call("list_sales", {}))).rejects.toBeInstanceOf(HandBackToRails);
  });
});
