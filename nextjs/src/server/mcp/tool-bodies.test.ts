import type { OauthAccessToken, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";

import { RpcSession } from "./server.ts";
import {
  toolBody,
  ToolError,
  ToolRpcError,
  type CustomerReader,
  type PayoutReader,
  type PayoutRow,
  type SalesTotalsReader,
} from "./tool-bodies.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws19-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const user = (attributes: Partial<User> = {}) =>
  ({
    id: 7,
    external_id: "ext123==",
    name: "Ada Seller",
    username: "ada_seller",
    currency_type: "eur",
    timezone: "UTC",
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

const customerReader = (overrides: Partial<CustomerReader> = {}) => ({
  spend: vi.fn<CustomerReader["spend"]>().mockResolvedValue([]),
  conversion: vi.fn<CustomerReader["conversion"]>().mockResolvedValue([]),
  ...overrides,
});
const customerContext = (scopes: string, customers: CustomerReader, owner = user()) => ({
  user: owner,
  token: token(scopes),
  customers,
});
const EASTERN = "Eastern Time (US & Canada)";

describe("get_customers", () => {
  it("returns one row per buyer with the wire names and ISO 8601 times", async () => {
    const customers = customerReader({
      spend: vi.fn().mockResolvedValue([
        {
          email: "a@example.com",
          orders: 3,
          spend_cents: 4500,
          refunded_cents: 500,
          chargedback_cents: 0,
          first_at: new Date("2026-01-02T03:04:05Z"),
          last_at: new Date("2026-02-03T04:05:06Z"),
        },
      ]),
    });

    const body = await toolBody("get_customers", {}, customerContext("view_sales", customers));

    expect(body).toEqual({
      breakdown: "spend",
      currency: "usd",
      time_zone: "UTC",
      start_date: null,
      end_date: null,
      rows: [
        {
          email: "a@example.com",
          orders_count: 3,
          total_spend_cents: 4500,
          refunded_cents: 500,
          chargedback_cents: 0,
          first_order_at: "2026-01-02T03:04:05Z",
          last_order_at: "2026-02-03T04:05:06Z",
        },
      ],
    });
    expect(customers.spend).toHaveBeenCalledWith({ sellerId: 7n, email: null, from: null, until: null, limit: 25 });
  });

  it("reads the date range as days in the seller's zone, the end date inclusive", async () => {
    const customers = customerReader();

    const body = await toolBody(
      "get_customers",
      { start_date: "2026-03-01", end_date: "2026-03-02", email: "  b@example.com " },
      customerContext("account", customers, user({ timezone: EASTERN })),
    );

    expect(customers.spend).toHaveBeenCalledWith({
      sellerId: 7n,
      email: "b@example.com",
      from: "2026-03-01 05:00:00",
      until: "2026-03-03 05:00:00",
      limit: 25,
    });
    expect(body).toMatchObject({ start_date: "2026-03-01", end_date: "2026-03-02" });
  });

  it("moves the end bound by the zone offset in force on the next day", async () => {
    const customers = customerReader();
    const owner = user({ timezone: EASTERN });

    await toolBody("get_customers", { end_date: "2026-03-08" }, customerContext("account", customers, owner));

    expect(customers.spend).toHaveBeenCalledWith(expect.objectContaining({ until: "2026-03-09 04:00:00" }));
  });

  it("treats blank filters as absent", async () => {
    const customers = customerReader();

    await toolBody(
      "get_customers",
      { email: " ", start_date: "", end_date: "  " },
      customerContext("account", customers),
    );

    expect(customers.spend).toHaveBeenCalledWith({ sellerId: 7n, email: null, from: null, until: null, limit: 25 });
  });

  it("returns conversion rows with days to convert rounded to a tenth", async () => {
    const customers = customerReader({
      conversion: vi.fn().mockResolvedValue([
        {
          email: "c@example.com",
          free_at: new Date("2026-01-01T00:00:00Z"),
          converted_at: new Date("2026-01-02T12:00:00Z"),
        },
      ]),
    });

    const body = await toolBody(
      "get_customers",
      { breakdown: "conversion", limit: 5 },
      customerContext("account", customers),
    );

    expect(customers.conversion).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    expect(body).toMatchObject({
      breakdown: "conversion",
      rows: [
        {
          email: "c@example.com",
          free_at: "2026-01-01T00:00:00Z",
          converted_at: "2026-01-02T12:00:00Z",
          days_to_convert: 1.5,
        },
      ],
    });
  });

  it("hands back a conversion whose days to convert is a whole number, which Ruby writes as 2.0", async () => {
    const customers = customerReader({
      conversion: vi.fn().mockResolvedValue([
        {
          email: "c@example.com",
          free_at: new Date("2026-01-01T00:00:00Z"),
          converted_at: new Date("2026-01-03T00:00:00Z"),
        },
      ]),
    });

    await expect(
      toolBody("get_customers", { breakdown: "conversion" }, customerContext("account", customers)),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("refuses a start date after the end date", async () => {
    await expect(
      toolBody(
        "get_customers",
        { start_date: "2026-03-02", end_date: "2026-03-01" },
        customerContext("account", customerReader()),
      ),
    ).rejects.toMatchObject({ message: "start_date must not be after end_date", code: -32602 });
  });

  it("refuses a date that is not on the calendar", async () => {
    await expect(
      toolBody("get_customers", { start_date: "2026-02-30" }, customerContext("account", customerReader())),
    ).rejects.toMatchObject({ message: "start_date must be a date like 2026-10-31", code: -32602 });
  });

  it("hands back a date in another ISO 8601 form", async () => {
    await expect(
      toolBody("get_customers", { end_date: "20261031" }, customerContext("account", customerReader())),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a query that ran out of time", async () => {
    const customers = customerReader({
      spend: vi
        .fn()
        .mockRejectedValue(new Error("Query execution was interrupted, maximum statement execution time exceeded")),
    });

    await expect(toolBody("get_customers", {}, customerContext("account", customers))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("refuses a limit outside 1 to 50", async () => {
    await expect(
      toolBody("get_customers", { limit: 51 }, customerContext("account", customerReader())),
    ).rejects.toMatchObject({ message: "limit must be between 1 and 50", code: -32602 });
  });

  it("hands back to Rails without a sales scope", async () => {
    await expect(
      toolBody("get_customers", {}, customerContext("view_payouts", customerReader())),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });
});

const totalsReader = (overrides: Partial<SalesTotalsReader> = {}) => ({
  byProduct: vi.fn<SalesTotalsReader["byProduct"]>().mockResolvedValue([]),
  productNames: vi.fn<SalesTotalsReader["productNames"]>().mockResolvedValue(new Map()),
  findProductId: vi.fn<SalesTotalsReader["findProductId"]>().mockResolvedValue(null),
  ...overrides,
});
const NOW = new Date("2026-03-15T12:00:00Z");
const totalsContext = (salesTotals: SalesTotalsReader, scopes = "view_sales", owner = user(), now = NOW) => ({
  user: owner,
  token: token(scopes),
  salesTotals,
  now: () => now,
});

describe("get_sales_totals", () => {
  it("defaults to the last 30 days ending today in the seller's zone", async () => {
    const salesTotals = totalsReader();

    const body = await toolBody("get_sales_totals", {}, totalsContext(salesTotals));

    expect(body).toEqual({
      start_date: "2026-02-14",
      end_date: "2026-03-15",
      time_zone: "UTC",
      currency: "usd",
      breakdown: "product",
      totals: { revenue_cents: 0, units: 0, average_order_value_cents: null },
      rows: [],
    });
    expect(salesTotals.byProduct).toHaveBeenCalledWith({
      sellerId: 7n,
      productId: null,
      from: "2026-02-14 00:00:00",
      until: "2026-03-16 00:00:00",
    });
  });

  it("takes today from the seller's zone, not UTC", async () => {
    const hawaii = totalsContext(
      totalsReader(),
      "view_sales",
      user({ timezone: "Hawaii" }),
      new Date("2026-03-15T05:00:00Z"),
    );

    await expect(toolBody("get_sales_totals", {}, hawaii)).resolves.toMatchObject({ end_date: "2026-03-14" });
  });

  it("ranks products by revenue with names, average order value and totals over every product", async () => {
    const salesTotals = totalsReader({
      byProduct: vi.fn().mockResolvedValue([
        { link_id: 1n, revenue_cents: 1000, units: 3 },
        { link_id: 2n, revenue_cents: 5000, units: 2 },
      ]),
      productNames: vi.fn().mockResolvedValue(new Map([[2n, "Big pack"]])),
    });

    const body = await toolBody(
      "get_sales_totals",
      { start_date: "2026-03-01", end_date: "2026-03-02" },
      totalsContext(salesTotals),
    );

    expect(salesTotals.productNames).toHaveBeenCalledWith([2n, 1n]);
    expect(body).toMatchObject({
      totals: { revenue_cents: 6000, units: 5, average_order_value_cents: 1200 },
      rows: [
        { product_name: "Big pack", revenue_cents: 5000, units: 2, average_order_value_cents: 2500 },
        { product_name: null, revenue_cents: 1000, units: 3, average_order_value_cents: 333 },
      ],
    });
    expect(salesTotals.byProduct).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-03-01 00:00:00", until: "2026-03-03 00:00:00" }),
    );
  });

  it("keeps the top 100 rows but totals every product", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      link_id: BigInt(index + 1),
      revenue_cents: index + 1,
      units: 1,
    }));
    const body = await toolBody(
      "get_sales_totals",
      {},
      totalsContext(totalsReader({ byProduct: vi.fn().mockResolvedValue(rows) })),
    );

    expect((body!.rows as unknown[]).length).toBe(100);
    expect(body!.totals).toMatchObject({ units: 101 });
  });

  it("limits the query to one product when product_id resolves", async () => {
    const salesTotals = totalsReader({ findProductId: vi.fn().mockResolvedValue(42n) });

    await toolBody("get_sales_totals", { product_id: "abc" }, totalsContext(salesTotals));

    expect(salesTotals.findProductId).toHaveBeenCalledWith(7n, "abc");
    expect(salesTotals.byProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: 42n }));
  });

  it("fails with the tool error Rails raises for a product_id that does not resolve", async () => {
    const salesTotals = totalsReader();

    await expect(toolBody("get_sales_totals", { product_id: "nope" }, totalsContext(salesTotals))).rejects.toEqual(
      new ToolError("The product was not found."),
    );
    expect(salesTotals.byProduct).not.toHaveBeenCalled();
  });

  it("ignores a blank product_id", async () => {
    const salesTotals = totalsReader();

    await toolBody("get_sales_totals", { product_id: "  " }, totalsContext(salesTotals));

    expect(salesTotals.findProductId).not.toHaveBeenCalled();
    expect(salesTotals.byProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: null }));
  });

  it.each(["country", "day", "week", "month"])("hands back the %s breakdown", async (breakdown) => {
    await expect(toolBody("get_sales_totals", { breakdown }, totalsContext(totalsReader()))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("refuses a range spanning 367 days and accepts 366", async () => {
    await expect(
      toolBody("get_sales_totals", { start_date: "2025-03-14", end_date: "2026-03-15" }, totalsContext(totalsReader())),
    ).rejects.toMatchObject({ message: "The date range cannot exceed 366 days" });
    await expect(
      toolBody("get_sales_totals", { start_date: "2025-03-15", end_date: "2026-03-15" }, totalsContext(totalsReader())),
    ).resolves.toBeDefined();
  });

  it("refuses a start date after the end date", async () => {
    await expect(
      toolBody("get_sales_totals", { start_date: "2026-03-10", end_date: "2026-03-09" }, totalsContext(totalsReader())),
    ).rejects.toMatchObject({ message: "start_date must not be after end_date", code: -32602 });
  });

  it("hands back to Rails without a sales scope", async () => {
    await expect(
      toolBody("get_sales_totals", {}, totalsContext(totalsReader(), "view_profile")),
    ).rejects.toBeInstanceOf(HandBackToRails);
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

  it("answers a tool error as an error result, not a JSON-RPC error", async () => {
    const salesTotals = totalsReader();
    const reply = await new RpcSession(
      { protocolVersion: null, method: null, name: null },
      () => Promise.resolve(false),
      totalsContext(salesTotals),
    ).handle(call("get_sales_totals", { product_id: "nope" }));

    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "The product was not found." }], isError: true },
    });
  });

  it("still hands back a tool that is not ported", async () => {
    await expect(session("account").handle(call("list_sales", {}))).rejects.toBeInstanceOf(HandBackToRails);
  });
});
