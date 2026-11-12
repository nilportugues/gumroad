import type { OauthAccessToken, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";

import { RpcSession } from "./server.ts";
import {
  FloatValue,
  toolBody,
  toolText,
  ToolError,
  ToolRpcError,
  type CustomerReader,
  type PayoutReader,
  type PayoutRow,
  type ProductFileRow,
  type ProductListRow,
  type ProductsReader,
  type SaleRow,
  type SubscriptionPurchaseRow,
  type SubscriptionRow,
  type SubscriptionsReader,
  type SalesReader,
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
  byCountry: vi.fn<SalesTotalsReader["byCountry"]>().mockResolvedValue([]),
  byPeriod: vi.fn<SalesTotalsReader["byPeriod"]>().mockResolvedValue([]),
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

  it("names, merges and orders the countries of the country breakdown", async () => {
    const salesTotals = totalsReader({
      byCountry: vi.fn().mockResolvedValue([
        { country: "USA", revenue_cents: 700, units: 1 },
        { country: "United States", revenue_cents: 300, units: 2 },
        { country: "Germany", revenue_cents: 2000, units: 3 },
        { country: null, revenue_cents: 50, units: 1 },
      ]),
    });
    const body = await toolBody(
      "get_sales_totals",
      { breakdown: "country", start_date: "2026-03-01", end_date: "2026-03-31" },
      totalsContext(salesTotals),
    );
    expect(body).toMatchObject({
      breakdown: "country",
      totals: { revenue_cents: 3050, units: 7, average_order_value_cents: 436 },
      rows: [
        { country: "Germany", revenue_cents: 2000, units: 3 },
        { country: "United States", revenue_cents: 1000, units: 3, average_order_value_cents: 333 },
        { country: null, revenue_cents: 50, units: 1, average_order_value_cents: 50 },
      ],
    });
  });

  it("hands back a country breakdown with a spelling outside the country list, or with equal revenues", async () => {
    const unknown = totalsReader({
      byCountry: vi.fn().mockResolvedValue([{ country: "Atlantis", revenue_cents: 1, units: 1 }]),
    });
    await expect(toolBody("get_sales_totals", { breakdown: "country" }, totalsContext(unknown))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    const tied = totalsReader({
      byCountry: vi.fn().mockResolvedValue([
        { country: "Germany", revenue_cents: 5, units: 1 },
        { country: "France", revenue_cents: 5, units: 1 },
      ]),
    });
    await expect(toolBody("get_sales_totals", { breakdown: "country" }, totalsContext(tied))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });

  it("buckets by local date in constant-offset segments and orders the rows by date", async () => {
    const byPeriod = vi.fn().mockResolvedValue([
      { key: "2026-03-09", revenue_cents: 100, units: 1 },
      { key: "2026-03-02", revenue_cents: 300, units: 2 },
      { key: "2026-03-09", revenue_cents: 50, units: 1 },
    ]);
    const owner = { ...user(), timezone: "Pacific Time (US & Canada)" } as User;
    const body = await toolBody(
      "get_sales_totals",
      { breakdown: "week", start_date: "2026-03-01", end_date: "2026-03-15" },
      totalsContext(totalsReader({ byPeriod }), "view_sales", owner),
    );
    // US daylight saving began 2026-03-08 at 10:00 UTC, which splits the range in two.
    expect(byPeriod).toHaveBeenCalledWith(
      expect.objectContaining({
        period: "week",
        segments: [
          { from: "2026-03-01 08:00:00", until: "2026-03-08 10:00:00", offsetSeconds: -28_800 },
          { from: "2026-03-08 10:00:00", until: "2026-03-16 07:00:00", offsetSeconds: -25_200 },
        ],
      }),
    );
    expect(body).toMatchObject({
      breakdown: "week",
      totals: { revenue_cents: 450, units: 4 },
      rows: [
        { date: "2026-03-02", revenue_cents: 300, units: 2 },
        { date: "2026-03-09", revenue_cents: 150, units: 2 },
      ],
    });
  });

  it.each(["day", "month"])(
    "reads the %s breakdown from byPeriod in one segment for a zone without transitions",
    async (breakdown) => {
      const byPeriod = vi.fn().mockResolvedValue([]);
      const body = await toolBody(
        "get_sales_totals",
        { breakdown, start_date: "2026-03-01", end_date: "2026-03-02" },
        totalsContext(totalsReader({ byPeriod })),
      );
      expect(byPeriod).toHaveBeenCalledWith(
        expect.objectContaining({
          period: breakdown,
          segments: [{ from: "2026-03-01 00:00:00", until: "2026-03-03 00:00:00", offsetSeconds: 0 }],
        }),
      );
      expect(body).toMatchObject({ rows: [], totals: { revenue_cents: 0, units: 0, average_order_value_cents: null } });
    },
  );

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
    await expect(toolBody("publish_product", { id: "x" }, context("account"))).resolves.toBeUndefined();
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
    await expect(session("account").handle(call("publish_product", { id: "x" }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});

const sale = (id: number, attributes: Partial<SaleRow> = {}): SaleRow => ({
  id: BigInt(id),
  email: "ada@example.com",
  link_id: 5n,
  product_name: "Sketch pack",
  price_cents: 1000,
  fee_cents: 100,
  affiliate_credit_cents: 50,
  created_at: new Date("2026-03-02T10:00:00Z"),
  stripe_refunded: false,
  chargeback_date: null,
  subscription_id: null,
  subscription_flags: null,
  country: null,
  ip_country: "United States",
  offer_code: null,
  referrer: "  ",
  utm_driven_count: 0,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_term: null,
  utm_content: null,
  ...attributes,
});
const salesReader = (rows: SaleRow[] = [], overrides: Partial<SalesReader> = {}) => ({
  list: vi.fn<SalesReader["list"]>().mockResolvedValue(rows),
  findProductId: vi.fn<SalesReader["findProductId"]>().mockResolvedValue(5n),
  ...overrides,
});
const salesContext = (sales: SalesReader, scopes = "view_sales") => ({ user: user(), token: token(scopes), sales });

describe("list_sales", () => {
  it("renders a sale with its net, country fallback and blank referrer", async () => {
    const body = await toolBody("list_sales", {}, salesContext(salesReader([sale(1)])));

    expect(body).toEqual({
      sales: [
        expect.objectContaining({
          price_cents: 1000,
          fee_cents: 100,
          affiliate_commission_cents: 50,
          net_cents: 850,
          currency: "usd",
          created_at: "2026-03-02T10:00:00Z",
          refunded: false,
          chargedback: false,
          subscription: false,
          country: "United States",
          referrer: null,
        }),
      ],
    });
  });

  it("marks a membership charge as a subscription but not an installment plan", async () => {
    const plan = BigInt(1 << 6);
    const body = (await toolBody(
      "list_sales",
      {},
      salesContext(
        salesReader([
          sale(2, { subscription_id: 1n, subscription_flags: 0n }),
          sale(1, { subscription_id: 2n, subscription_flags: plan }),
        ]),
      ),
    )) as { sales: { subscription: boolean }[] };
    expect(body.sales.map((row) => row.subscription)).toEqual([true, false]);
  });

  it("fetches one extra row and returns a cursor in microseconds when another page exists", async () => {
    const reader = salesReader([sale(3), sale(2, { created_at: new Date("2026-03-02T09:00:00Z") }), sale(1)]);
    const body = (await toolBody("list_sales", { limit: 2 }, salesContext(reader))) as {
      sales: unknown[];
      next_cursor?: string;
    };
    expect(reader.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
    expect(body.sales).toHaveLength(2);
    expect(body.next_cursor).toBe("1772442000000000_2");
  });

  it("passes the filters as UTC datetimes and trims the email", async () => {
    const reader = salesReader();
    await toolBody(
      "list_sales",
      {
        email: " ada@example.com ",
        after: "2026-03-01",
        before: "2026-03-05T10:00:00+02:00",
        payment: "paid",
        kind: "one_time",
      },
      salesContext(reader),
    );
    expect(reader.list).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ada@example.com",
        after: "2026-03-01 00:00:00",
        before: "2026-03-05 08:00:00",
        payment: "paid",
        kind: "one_time",
        productId: null,
      }),
    );
  });

  it("answers a product that does not resolve as a tool error, before checking the limit", async () => {
    const reader = salesReader([], { findProductId: vi.fn().mockResolvedValue(null) });
    await expect(
      toolBody("list_sales", { product_id: "nope", limit: 99 }, salesContext(reader)),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(toolBody("list_sales", { limit: 99 }, salesContext(salesReader()))).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("hands back a time written in a form it does not read, and a sale with several UTM links", async () => {
    await expect(toolBody("list_sales", { after: "last tuesday" }, salesContext(salesReader()))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    await expect(
      toolBody("list_sales", {}, salesContext(salesReader([sale(1, { utm_driven_count: 2 })]))),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });
});

const productRow = (id: number, attributes: Partial<ProductListRow> = {}): ProductListRow => ({
  id: BigInt(id),
  created_at: new Date("2026-03-02T10:00:00Z"),
  name: "Sketch pack",
  buy_price_count: 1,
  buy_price_cents: 1000,
  purchase_type: 0,
  price_currency_type: "usd",
  customizable_price: false,
  suggested_price_cents: null,
  purchase_disabled_at: null,
  draft: false,
  flags: 0n,
  unique_permalink: "sketchpk",
  custom_permalink: null,
  ...attributes,
});
const productsContext = (rows: ProductListRow[], scopes = "view_public") => ({
  user: user(),
  token: token(scopes),
  products: {
    list: vi.fn<ProductsReader["list"]>().mockResolvedValue(rows),
    find: vi.fn<ProductsReader["find"]>(),
    files: vi.fn<ProductsReader["files"]>(),
    covers: vi.fn<ProductsReader["covers"]>(),
  },
});

describe("list_products", () => {
  it("renders a product with its price, publication state and storefront url", async () => {
    const context = productsContext([
      productRow(1, { customizable_price: true, suggested_price_cents: 900, custom_permalink: "sketch" }),
      productRow(2, { draft: true, flags: BigInt(1 << 25), buy_price_count: 0, buy_price_cents: null }),
    ]);
    const body = (await toolBody("list_products", {}, context)) as { products: Record<string, unknown>[] };

    expect(body.products[0]).toMatchObject({
      name: "Sketch pack",
      price_cents: 1000,
      currency: "usd",
      pay_what_you_want: true,
      suggested_price_cents: 900,
      published: true,
      is_bundle: false,
      url: expect.stringMatching(/^https?:\/\/ada-seller\..*\/l\/sketch$/u),
      permalink: "sketchpk",
    });
    expect(body.products[1]).toMatchObject({
      price_cents: null,
      published: false,
      is_bundle: true,
      suggested_price_cents: null,
    });
  });

  it("returns a cursor in microseconds when another page exists", async () => {
    const context = productsContext([productRow(3), productRow(2), productRow(1)]);
    const body = (await toolBody("list_products", { limit: 2 }, context)) as {
      products: unknown[];
      next_cursor?: string;
    };
    expect(context.products.list).toHaveBeenCalledWith(7n, 3, null);
    expect(body.products).toHaveLength(2);
    expect(body.next_cursor).toBe("1772445600000000_2");
  });

  it("hands back a tiered membership, a rental or recurring product and competing buy prices", async () => {
    for (const row of [
      productRow(1, { flags: BigInt(1 << 18) }),
      productRow(1, { flags: BigInt(1 << 1) }),
      productRow(1, { purchase_type: 1 }),
      productRow(1, { buy_price_count: 2 }),
    ])
      await expect(toolBody("list_products", {}, productsContext([row]))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

const detailContext = (scopes: string, row: ProductListRow | null, description: string | null = "Draw more") => {
  const context = productsContext([], scopes);
  context.products.find.mockResolvedValue(row === null ? null : { ...row, description });
  context.products.files.mockResolvedValue([]);
  context.products.covers.mockResolvedValue([]);
  return Object.assign(context, {
    productStats: vi.fn().mockResolvedValue({ sales_count: 3, sales_usd_cents: 2500 }),
  });
};

describe("get_product", () => {
  it("adds the description and covers, and the sales figures only to a token with a sales scope", async () => {
    const without = detailContext("view_public", productRow(1));
    without.products.covers.mockResolvedValue([
      { guid: "cover1", unsplash_url: "https://i.example.com/a", has_oembed: false },
    ]);
    expect(await toolBody("get_product", { id: "sketchpk" }, without)).toEqual({
      product: expect.objectContaining({
        permalink: "sketchpk",
        description: "Draw more",
        covers: [{ id: "cover1", url: "https://i.example.com/a", type: "unsplash" }],
      }),
    });
    expect(without.productStats).not.toHaveBeenCalled();

    const sales = detailContext("view_public view_sales", productRow(1));
    expect(await toolBody("get_product", { id: "sketchpk" }, sales)).toEqual({
      product: expect.objectContaining({ sales_count: 3, sales_usd_cents: 2500 }),
    });
  });

  it("refuses a blank id, answers a missing product as a tool error and hands back what it cannot read", async () => {
    await expect(toolBody("get_product", { id: " " }, detailContext("view_public", null))).rejects.toMatchObject({
      code: -32602,
      message: "id is required",
    });
    await expect(toolBody("get_product", { id: "nope" }, detailContext("view_public", null))).rejects.toBeInstanceOf(
      ToolError,
    );
    const covered = detailContext("view_public", productRow(1));
    covered.products.covers.mockResolvedValue([{ guid: "c", unsplash_url: null, has_oembed: false }]);
    await expect(toolBody("get_product", { id: "x" }, covered)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(
      toolBody("get_product", { id: "x" }, detailContext("view_public", productRow(1, { flags: BigInt(1 << 25) }))),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });
});

const fileRow = (id: number, attributes: Partial<ProductFileRow> = {}): ProductFileRow => ({
  id: BigInt(id),
  display_name: null,
  url: null,
  filetype: "link",
  size: null,
  position: id,
  ...attributes,
});

describe("list_files", () => {
  it("names each file the way the product page does", async () => {
    const context = detailContext("edit_products", productRow(1));
    context.products.files.mockResolvedValue([
      fileRow(1, { display_name: "Guide", filetype: "pdf", size: 2048n }),
      fileRow(2, { url: "https://example.com/x" }),
    ]);
    const body = (await toolBody("list_files", { id: "sketchpk" }, context)) as { files: Record<string, unknown>[] };
    expect(body.files).toEqual([
      { id: expect.any(String), name: "Guide", type: "PDF", size_bytes: 2048, position: 1 },
      { id: expect.any(String), name: "https://example.com/x", type: "URL", size_bytes: 0, position: 2 },
    ]);
  });

  it("hands back files that share a position", async () => {
    const context = detailContext("edit_products", productRow(1));
    context.products.files.mockResolvedValue([fileRow(1, { position: 0 }), fileRow(2, { position: 0 })]);
    await expect(toolBody("list_files", { id: "x" }, context)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("toolText", () => {
  it("prints a Ruby Float with its fraction and leaves an integer and a lookalike string alone", () => {
    const marker = "float:abc:0.5";
    expect(toolText({ whole: new FloatValue(1500), part: new FloatValue(0.25), count: 3, note: marker })).toBe(
      JSON.stringify({ whole: "@", part: "@", count: 3, note: marker }, null, 2)
        .replace('"whole": "@"', '"whole": 1500.0')
        .replace('"part": "@"', '"part": 0.25'),
    );
  });
});

describe("get_analytics", () => {
  const series = (...values: number[]) => values;
  const analyticsContext = (by: "date" | "referral", data: Record<string, unknown>) => {
    const reader = {
      data: vi.fn().mockResolvedValue(data),
      names: vi.fn().mockResolvedValue(
        new Map([
          ["alpha", { id: 1n, name: "Alpha" }],
          ["beta", { id: 2n, name: "Beta" }],
        ]),
      ),
    };
    const context = productsContext([], "view_sales");
    context.products.find.mockResolvedValue(null);
    return {
      ...context,
      user: user({ timezone: "UTC", created_at: new Date("2026-01-01T00:00:00Z") }),
      now: () => new Date("2026-03-31T12:00:00Z"),
      analytics: reader,
      by,
    };
  };
  const byDate = {
    by_date: {
      views: { alpha: series(2, 1), beta: series(4) },
      sales: { alpha: series(1, 0), beta: series(1) },
      totals: { alpha: series(500, 0), beta: series(700) },
    },
  };

  it("sums each product, most viewed first, with the conversion rate rounded to four places", async () => {
    const context = analyticsContext("date", byDate);
    const body = (await toolBody("get_analytics", { start_date: "2026-03-01", end_date: "2026-03-31" }, context)) as {
      rows: Record<string, unknown>[];
    };
    expect(context.analytics.data).toHaveBeenCalledWith(context.user, "2026-03-01", "2026-03-31", "date");
    expect(body.rows).toEqual([
      expect.objectContaining({ product_name: "Beta", views: 4, sales: 1, revenue_cents: 700 }),
      expect.objectContaining({ product_name: "Alpha", views: 3, sales: 1, revenue_cents: 500 }),
    ]);
    expect(body.rows.map((row) => String((row.conversion_rate as FloatValue).value))).toEqual(["0.25", "0.3333"]);
  });

  it("answers an empty range for a range that ends before the account existed, without reading analytics", async () => {
    const context = analyticsContext("date", byDate);
    const body = await toolBody("get_analytics", { start_date: "2025-11-01", end_date: "2025-12-30" }, context);
    expect(body).toMatchObject({ rows: [], breakdown: "product" });
    expect(context.analytics.data).not.toHaveBeenCalled();
  });

  it("totals referrers across products and keeps the first 50", async () => {
    const referral = {
      by_referral: {
        views: { alpha: { direct: series(3), twitter: series(1) }, beta: { direct: series(2) } },
        sales: { alpha: { direct: series(1) }, beta: {} },
        totals: { alpha: { direct: series(500) }, beta: {} },
      },
    };
    const body = (await toolBody(
      "get_analytics",
      { breakdown: "referrer", start_date: "2026-03-01", end_date: "2026-03-31" },
      analyticsContext("referral", referral),
    )) as { rows: Record<string, unknown>[] };
    expect(body.rows).toEqual([
      expect.objectContaining({ referrer: "direct", views: 5, sales: 1, revenue_cents: 500 }),
      expect.objectContaining({ referrer: "twitter", views: 1, sales: 0, revenue_cents: 0 }),
    ]);
  });

  it("hands back rows with equal views, keys a JavaScript object would reorder and an unreadable date", async () => {
    const tied = { by_date: { ...byDate.by_date, views: { alpha: series(2), beta: series(2) } } };
    await expect(toolBody("get_analytics", {}, analyticsContext("date", tied))).rejects.toBeInstanceOf(HandBackToRails);
    const numeric = { by_date: { ...byDate.by_date, views: { "10": series(2), alpha: series(1) } } };
    await expect(toolBody("get_analytics", {}, analyticsContext("date", numeric))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    await expect(
      toolBody("get_analytics", { start_date: "March 1" }, analyticsContext("date", byDate)),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("refuses a reversed or oversized range", async () => {
    const context = analyticsContext("date", byDate);
    await expect(
      toolBody("get_analytics", { start_date: "2026-03-10", end_date: "2026-03-01" }, context),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      toolBody("get_analytics", { start_date: "2024-01-01", end_date: "2026-03-31" }, context),
    ).rejects.toMatchObject({ message: "The date range cannot exceed 366 days" });
  });
});

describe("get_subscriptions", () => {
  const subscription = (attributes: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    id: 5n,
    link_id: 9n,
    product_name: "Club",
    created_at: new Date("2026-03-02T10:00:00Z"),
    created_micros: 1772445600000000n,
    cancelled_at: null,
    failed_at: null,
    ended_at: null,
    deactivated_at: null,
    flags: 0n,
    user_email: null,
    user_unconfirmed_email: null,
    ...attributes,
  });
  const purchase = (id: number, attributes: Partial<SubscriptionPurchaseRow> = {}): SubscriptionPurchaseRow => ({
    id: BigInt(id),
    subscription_id: 5n,
    purchase_state: "successful",
    flags: 1n << 2n,
    email: "ada@example.com",
    created_micros: BigInt(id) * 1_000_000n,
    ...attributes,
  });
  const subscriptionsContext = (rows: SubscriptionRow[], purchases: SubscriptionPurchaseRow[]) => ({
    ...productsContext([], "view_sales"),
    now: () => new Date("2026-03-10T00:00:00Z"),
    subscriptions: {
      list: vi.fn<SubscriptionsReader["list"]>().mockResolvedValue(rows),
      purchases: vi.fn<SubscriptionsReader["purchases"]>().mockResolvedValue(purchases),
    },
  });

  it("reports each subscription with its email, status and failed payments", async () => {
    const context = subscriptionsContext(
      [subscription()],
      [purchase(1), purchase(2, { purchase_state: "failed", flags: 0n, created_micros: 9_000_000n })],
    );
    expect(await toolBody("get_subscriptions", {}, context)).toEqual({
      breakdown: "subscriptions",
      subscriptions: [
        {
          id: expect.any(String),
          product_id: expect.any(String),
          product_name: "Club",
          email: "ada@example.com",
          status: "pending_failure",
          started_at: "2026-03-02T10:00:00Z",
          cancelled_at: null,
          failed_at: null,
          ended_at: null,
          failed_payments: 1,
        },
      ],
    });
  });

  it("prefers the subscriber's account email and gives the cursor in microseconds when another page exists", async () => {
    const context = subscriptionsContext(
      [
        subscription({ user_unconfirmed_email: "new@example.com", user_email: "old@example.com" }),
        subscription({ id: 4n }),
      ],
      [purchase(1)],
    );
    const body = (await toolBody("get_subscriptions", { limit: 1 }, context)) as {
      subscriptions: { email: string }[];
      next_cursor: string;
    };
    expect(body.subscriptions[0]!.email).toBe("new@example.com");
    expect(body.next_cursor).toBe("1772445600000000_5");
    expect(context.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, status: null }));
  });

  it("hands back churn, a mandate, a gift, several original purchases and tied newest purchases", async () => {
    const hands = async (context: ReturnType<typeof subscriptionsContext>, args = {}) =>
      expect(toolBody("get_subscriptions", args, context)).rejects.toBeInstanceOf(HandBackToRails);
    await hands(subscriptionsContext([], []), { breakdown: "churn" });
    await hands(subscriptionsContext([subscription({ flags: 1n << 7n })], [purchase(1)]));
    await hands(subscriptionsContext([subscription()], [purchase(1, { flags: (1n << 2n) | (1n << 6n) })]));
    await hands(subscriptionsContext([subscription()], [purchase(1), purchase(2)]));
    await hands(
      subscriptionsContext([subscription()], [purchase(1), purchase(2, { flags: 0n, created_micros: 1_000_000n })]),
    );
  });
});
