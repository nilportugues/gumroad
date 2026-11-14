import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17b-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn() }));
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows: mocks.selectRows,
}));

const { index, show } = await import("./payouts.ts");
const { encrypt } = await import("../../../lib/obfuscate-ids.ts");

const owner = { id: 7n } as never;
const request = { path: "/v2/payouts", queryString: "include_upcoming=false" } as never;
const payment = (over: Record<string, unknown> = {}) => ({
  id: 5n,
  user_id: 7n,
  amount_cents: 123456n,
  currency: "usd",
  state: "completed",
  created_at: new Date("2024-03-01T10:00:00Z"),
  updated_at: new Date("2024-03-02T11:30:00Z"),
  processor: "STRIPE",
  bank_account_id: null,
  payment_address: null,
  created_usec: "20240301100000000000",
  ...over,
});
const body = (rendered: { body?: unknown }) => JSON.parse(String(rendered.body));
const sqlText = (call: number) => (mocks.selectRows.mock.calls[call]![0] as { sql: string }).sql;

beforeEach(() => mocks.selectRows.mockReset());

describe("Api::V2::PayoutsController#index", () => {
  it("lists the payouts newest first with Payment#as_json fields", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment()]);
    const result = body(await index({ owner, params: { include_upcoming: "false" }, request }));
    expect(result).toEqual({
      success: true,
      payouts: [
        {
          id: encrypt(5n),
          amount: "1234.56",
          currency: "usd",
          status: "completed",
          created_at: "2024-03-01T10:00:00Z",
          processed_at: "2024-03-02T11:30:00Z",
          payment_processor: "STRIPE",
          bank_account_visual: null,
          paypal_email: null,
        },
      ],
    });
    expect(sqlText(0)).toContain("ORDER BY `payments`.`created_at` DESC, `payments`.`id` DESC LIMIT");
  });

  it("leaves processed_at empty unless the payout is completed", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment({ state: "failed" })]);
    expect(
      body(await index({ owner, params: { include_upcoming: "false" }, request })).payouts[0].processed_at,
    ).toBeNull();
  });

  it("shows the destination bank account as asterisks and its last four digits", async () => {
    mocks.selectRows
      .mockResolvedValueOnce([payment({ bank_account_id: 3 })])
      .mockResolvedValueOnce([{ id: 3, type: "AchAccount", account_number_last_four: "6789" }]);
    expect(
      body(await index({ owner, params: { include_upcoming: "false" }, request })).payouts[0].bank_account_visual,
    ).toBe("******6789");
  });

  it("adds a next page key when a page is full", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => payment({ id: BigInt(20 - i) }));
    mocks.selectRows.mockResolvedValueOnce(rows);
    const result = body(await index({ owner, params: { include_upcoming: "false" }, request }));
    expect(result.payouts).toHaveLength(10);
    expect(result.next_page_key).toMatch(/^20240301100000000000-\d+$/u);
    expect(result.next_page_url).toBe(`/v2/payouts?include_upcoming=false&page_key=${result.next_page_key}`);
  });

  it("rejects a before date that does not exist", async () => {
    const rendered = await index({ owner, params: { before: "2024-02-30" }, request });
    expect(rendered.status).toBe(400);
    expect(body(rendered).error).toBe(
      "Invalid date format provided in field 'before'. Dates must be in the format YYYY-MM-DD.",
    );
  });

  it("rejects an after date that does not exist", async () => {
    const rendered = await index({ owner, params: { after: "2024-13-01" }, request });
    expect(body(rendered).error).toBe(
      "Invalid date format provided in field 'after'. Dates must be in the format YYYY-MM-DD.",
    );
  });

  it("rejects a page key it cannot decode", async () => {
    const rendered = await index({ owner, params: { page_key: "garbage" }, request });
    expect(body(rendered).error).toBe("Invalid page_key.");
  });

  it("filters by the given dates", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    await index({ owner, params: { after: "2024-01-01", before: "2024-02-01", include_upcoming: "false" }, request });
    const call = mocks.selectRows.mock.calls[0]![0] as { values: unknown[] };
    expect(call.values).toEqual(expect.arrayContaining(["2024-01-01", "2024-02-01"]));
  });

  it("hands back the first page, which carries the upcoming payouts", async () => {
    await expect(index({ owner, params: {}, request })).rejects.toThrow(/upcoming/u);
    expect(mocks.selectRows).not.toHaveBeenCalled();
  });

  it("hands back dates it does not parse and non-text parameters", async () => {
    await expect(index({ owner, params: { before: "2024-1-5" }, request })).rejects.toThrow(/YYYY-MM-DD/u);
    await expect(index({ owner, params: { before: ["2024-01-01"] }, request })).rejects.toThrow(/non-text/u);
  });

  it.each([
    ["PolandBankAccount", "PL******6789"],
    ["BosniaAndHerzegovinaBankAccount", "BA******6789"],
    ["CoteDIvoireBankAccount", "CI******6789"],
    ["SwissBankAccount", "CH******6789"],
    ["UaeBankAccount", "AE******6789"],
    ["AchAccount", "******6789"],
  ])("prefixes the visual of a %s destination as Rails does", async (type, visual) => {
    mocks.selectRows
      .mockResolvedValueOnce([payment({ bank_account_id: 3 })])
      .mockResolvedValueOnce([{ id: 3, type, account_number_last_four: "6789" }]);
    expect(
      body(await index({ owner, params: { include_upcoming: "false" }, request })).payouts[0].bank_account_visual,
    ).toBe(visual);
  });

  it.each(["CardBankAccount", "EuropeanBankAccount"])("hands back a %s destination", async (type) => {
    mocks.selectRows
      .mockResolvedValueOnce([payment({ bank_account_id: 3 })])
      .mockResolvedValueOnce([{ id: 3, type, account_number_last_four: "6789" }]);
    await expect(index({ owner, params: { include_upcoming: "false" }, request })).rejects.toThrow(type);
  });
});

describe("Api::V2::PayoutsController#show", () => {
  const token = (scopes: string) => ({ scopes }) as never;

  it("answers a payout that is not found", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    expect(
      body(await show({ owner, params: {}, routeParams: { id: encrypt(99n) }, token: token("view_payouts") })),
    ).toEqual({ success: false, message: "The payout was not found." });
  });

  it("answers an id that does not decrypt without querying", async () => {
    expect(
      body(await show({ owner, params: {}, routeParams: { id: "!!" }, token: token("view_payouts") })).success,
    ).toBe(false);
    expect(mocks.selectRows).not.toHaveBeenCalled();
  });

  it("leaves the sales out for a token without view_sales", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment()]);
    const result = body(
      await show({ owner, params: {}, routeParams: { id: encrypt(5n) }, token: token("view_payouts") }),
    );
    expect(result.payout.sales).toBeUndefined();
  });

  it("lists sold, refunded and disputed sales for a token with view_sales", async () => {
    mocks.selectRows
      .mockResolvedValueOnce([payment()])
      .mockResolvedValueOnce([{ balance_id: 11n }])
      .mockResolvedValueOnce([{ id: 100n }, { id: 99n }])
      .mockResolvedValueOnce([{ id: 50n }])
      .mockResolvedValueOnce([]);
    const result = body(
      await show({ owner, params: {}, routeParams: { id: encrypt(5n) }, token: token("view_payouts view_sales") }),
    );
    expect(result.payout.sales).toEqual([encrypt(100n), encrypt(99n)]);
    expect(result.payout.refunded_sales).toEqual([encrypt(50n)]);
    expect(result.payout.disputed_sales).toEqual([]);
    expect(sqlText(2)).toContain("purchase_success_balance_id");
    expect(sqlText(3)).toContain("purchase_refund_balance_id");
    expect(sqlText(4)).toContain("purchase_chargeback_balance_id");
  });

  it("returns empty sale lists for a payout without balances", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment()]).mockResolvedValueOnce([]);
    const result = body(await show({ owner, params: {}, routeParams: { id: encrypt(5n) }, token: token("account") }));
    expect(result.payout).toMatchObject({ sales: [], refunded_sales: [], disputed_sales: [] });
  });

  it("omits the sales when include_sales is false", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment()]);
    const result = body(
      await show({
        owner,
        params: { include_sales: "false" },
        routeParams: { id: encrypt(5n) },
        token: token("account"),
      }),
    );
    expect(result.payout.sales).toBeUndefined();
  });

  it("hands back include_transactions", async () => {
    mocks.selectRows.mockResolvedValueOnce([payment()]);
    await expect(
      show({
        owner,
        params: { include_transactions: "true" },
        routeParams: { id: encrypt(5n) },
        token: token("account"),
      }),
    ).rejects.toThrow(/transactions/u);
  });
});
