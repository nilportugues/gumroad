// Vectors follow spec/controllers/customer_surcharge_controller_spec.rb (EU lookup-table tax, the USD-only currency menu,
// string quantities, an invalid price) and spec/requests/customer_surcharge_parity_spec.rb, plus the hand-backs.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";

const { selectRows, isFeatureEnabled, geoIpLookup, getRate, hasBrazilianStripeConnectAccount, findUserById, taxjar } =
  vi.hoisted(() => ({
    taxjar: vi.fn(),
    selectRows: vi.fn(),
    isFeatureEnabled: vi.fn(),
    geoIpLookup: vi.fn(),
    getRate: vi.fn(),
    hasBrazilianStripeConnectAccount: vi.fn(),
    findUserById: vi.fn(),
  }));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
  castRow: (_model: string, row: unknown) => row,
}));
vi.mock("../infra/flipper.ts", () => ({ isFeatureEnabled, userActor: (id: unknown) => `User;${id}` }));
vi.mock("../infra/geo-ip.ts", () => ({ geoIpLookup }));
vi.mock("../models/concerns/currency-helper.ts", async (original) => ({
  ...(await original<typeof import("../models/concerns/currency-helper.ts")>()),
  getRate,
  RateUnavailable: class RateUnavailable extends Error {},
}));
vi.mock("../tax/taxjar.ts", async (original) => ({
  ...(await original<typeof import("../tax/taxjar.ts")>()),
  calculateTaxForOrder: taxjar,
}));
vi.mock("../page-props/dashboard/payout-info.ts", () => ({ hasBrazilianStripeConnectAccount }));
vi.mock("../presenters/product-reads.ts", () => ({ findUserById }));
vi.mock("../models/user.ts", () => ({
  Users: { load: (row: unknown) => row },
  jsonDataForAttr: (row: { disable?: unknown }) => row.disable ?? false,
}));
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn(), remoteIp: () => "203.0.113.9" }));

const { calculateAll, detectedBuyerCurrency } = await import("./customer-surcharge.ts");
const { RateUnavailable } = await import("../models/concerns/currency-helper.ts");

// Link flag bit positions (models/link.ts).
const FLAG_BITS = {
  is_recurring_billing: 2,
  is_in_preorder_state: 4,
  is_physical: 8,
  is_epublication: 23,
  is_bundle: 26,
};
const flagsOf = (...names: (keyof typeof FLAG_BITS)[]) =>
  names.reduce((flags, name) => flags | (1n << BigInt(FLAG_BITS[name] - 1)), 0n);

const link = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  user_id: 5n,
  unique_permalink: "abc",
  price_currency_type: "usd",
  native_type: "digital",
  flags: 0n,
  ...extra,
});
const zipTaxRate = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  country: "DE",
  combined_rate: "0.1900000",
  user_id: null,
  ...extra,
});

const requestWith = (headers: Record<string, string> = {}, queryString = "") =>
  ({ headers: new Headers(headers), queryString }) as never;

let links: Record<string, unknown>[];
let rates: Record<string, unknown>[];
let bundleComponents: Record<string, unknown>[];
function stubDb() {
  selectRows.mockImplementation(async (query: { sql: string }) => {
    if (query.sql.includes("FROM `bundle_products`")) return bundleComponents;
    if (query.sql.includes("FROM `links`")) return links;
    if (query.sql.includes("FROM `zip_tax_rates`")) return rates;
    return [];
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  links = [link()];
  rates = [];
  bundleComponents = [];
  stubDb();
  isFeatureEnabled.mockResolvedValue(false);
  geoIpLookup.mockReturnValue(null);
  hasBrazilianStripeConnectAccount.mockResolvedValue(false);
  getRate.mockResolvedValue("1.5");
  findUserById.mockResolvedValue({ id: 5n });
});

const call = async (params: Record<string, unknown>) => {
  const result = (await calculateAll({ params, request: requestWith() })) as { status: number; body: string };
  return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown> };
};
const cart = (extra: Record<string, unknown> = {}, ...lines: Record<string, unknown>[]) => ({
  products: lines.length === 0 ? [{ permalink: "abc", price: 100, quantity: 1 }] : lines,
  ...extra,
});
const rejection = (params: Record<string, unknown>) => calculateAll({ params, request: requestWith() });

describe("POST /customer_surcharge", () => {
  it("answers a plain cart with the totals, USD alone and no quote", async () => {
    const { status, body } = await call(cart());

    expect(status).toBe(200);
    expect(body).toEqual({
      vat_id_valid: false,
      has_vat_id_input: false,
      shipping_rate_cents: 0,
      tax_cents: 0,
      tax_included_cents: 0,
      subtotal: 100,
      charge_canonical_total_cents: 100,
      commission_completion_canonical_total_cents: 0,
      direct_listed_line_allocations: null,
      direct_listed_amount_token: null,
      direct_listed_amount_token_expires_at: null,
      buyer_currency_quote: null,
      detected_buyer_currency: null,
      available_buyer_currencies: [{ code: "usd", label: "$ (US Dollars)" }],
    });
  });

  it("keeps the response keys in the order Rails renders them", async () => {
    const { body } = await call(cart());

    expect(Object.keys(body)).toEqual([
      "vat_id_valid",
      "has_vat_id_input",
      "shipping_rate_cents",
      "tax_cents",
      "tax_included_cents",
      "subtotal",
      "charge_canonical_total_cents",
      "commission_completion_canonical_total_cents",
      "direct_listed_line_allocations",
      "direct_listed_amount_token",
      "direct_listed_amount_token_expires_at",
      "buyer_currency_quote",
      "detected_buyer_currency",
      "available_buyer_currencies",
    ]);
  });

  it("returns the Gumroad-collected EU tax with a VAT id input when the buyer is in Germany", async () => {
    rates = [zipTaxRate()];

    const { body } = await call(cart({ country: "DE", postal_code: "10115" }));

    expect(body).toMatchObject({
      tax_cents: 19,
      subtotal: 100,
      has_vat_id_input: true,
      charge_canonical_total_cents: 119,
    });
  });

  it("reads a string price like to_d.to_i and an unparsable one as 0", async () => {
    expect((await call(cart({}, { permalink: "abc", price: "250.9", quantity: "3" }))).body).toMatchObject({
      subtotal: 250,
    });
    expect((await call(cart({}, { permalink: "abc", price: "invalid", quantity: 1 }))).body).toMatchObject({
      subtotal: 0,
      tax_cents: 0,
    });
  });

  it("charges no tax on a free line", async () => {
    rates = [zipTaxRate()];

    const { body } = await call(cart({ country: "DE" }, { permalink: "abc", price: 0, quantity: 1 }));

    expect(body).toMatchObject({ tax_cents: 0, subtotal: 0, has_vat_id_input: false });
  });

  it("charges no tax when the country has no rate", async () => {
    const { body } = await call(cart({ country: "DE" }));

    expect(body).toMatchObject({ tax_cents: 0, subtotal: 100, has_vat_id_input: false });
  });

  it("charges no tax in a country that collects only after its flag is on", async () => {
    rates = [zipTaxRate({ country: "JP", combined_rate: "0.1000000" })];

    expect((await call(cart({ country: "JP" }))).body).toMatchObject({ tax_cents: 0 });

    isFeatureEnabled.mockImplementation(async (name: string) => name === "collect_tax_jp");
    expect((await call(cart({ country: "JP" }))).body).toMatchObject({ tax_cents: 10, has_vat_id_input: true });
  });

  it("sums several lines and adds only positive taxes to the charge total", async () => {
    links = [link(), link({ unique_permalink: "def" })];
    rates = [zipTaxRate({ combined_rate: "0.2000000" })];
    selectRows.mockImplementation(async (query: { sql: string }) => {
      if (query.sql.includes("FROM `links`")) return [links.shift()];
      return query.sql.includes("FROM `zip_tax_rates`") ? rates : [];
    });

    const { body } = await call(
      cart({ country: "DE" }, { permalink: "abc", price: 1000 }, { permalink: "def", price: 500 }),
    );

    expect(body).toMatchObject({ subtotal: 1500, tax_cents: 300, charge_canonical_total_cents: 1800 });
  });

  it("withholds the charge totals when a permalink matches no product", async () => {
    links = [];

    const { body } = await call(cart());

    expect(body).toMatchObject({
      subtotal: 0,
      charge_canonical_total_cents: null,
      commission_completion_canonical_total_cents: null,
    });
  });

  it("serves a cart of sellers outside the buyer-currency rollout", async () => {
    isFeatureEnabled.mockImplementation(async (name: string) => name === "buyer_local_currency");

    expect((await call(cart())).status).toBe(200);
  });

  it("converts through the listed currency rate once per currency", async () => {
    links = [link({ price_currency_type: "gbp" })];

    await call(cart({}, { permalink: "abc", price: 100 }, { permalink: "abc", price: 200 }));

    expect(getRate).toHaveBeenCalledTimes(1);
    expect(getRate).toHaveBeenCalledWith("gbp");
  });

  it("reads a price that is a JSON float as its truncation", async () => {
    expect((await call(cart({}, { permalink: "abc", price: 99.99 }))).body).toMatchObject({ subtotal: 99 });
  });
});

describe("detected buyer currency", () => {
  it("is the GeoIP country's supported currency", async () => {
    geoIpLookup.mockReturnValue({ countryCode: "GB" });
    expect((await call(cart())).body).toMatchObject({ detected_buyer_currency: "gbp" });
    geoIpLookup.mockReturnValue({ countryCode: "DE" });
    expect((await call(cart())).body).toMatchObject({ detected_buyer_currency: "eur" });
    geoIpLookup.mockReturnValue({ countryCode: "US" });
    expect((await call(cart())).body).toMatchObject({ detected_buyer_currency: "usd" });
  });

  it("is the euro for Bulgaria, whose lev the gem still lists", () => {
    expect(detectedBuyerCurrency("203.0.113.9", () => ({ countryCode: "BG" }))).toBe("eur");
  });

  it("is null for a country whose currency is unsupported or unknown", () => {
    expect(detectedBuyerCurrency("203.0.113.9", () => ({ countryCode: "AR" }))).toBeNull();
    expect(detectedBuyerCurrency("203.0.113.9", () => ({ countryCode: "ZZ" }))).toBeNull();
  });

  it("is null without a GeoIP result or country", () => {
    expect(detectedBuyerCurrency(null, () => null)).toBeNull();
    expect(detectedBuyerCurrency("203.0.113.9", () => ({ countryCode: null }))).toBeNull();
    expect(detectedBuyerCurrency("203.0.113.9", () => ({ countryCode: "" }))).toBeNull();
  });

  it("keeps the menu to USD while the cart's seller is out of the rollout", async () => {
    geoIpLookup.mockReturnValue({ countryCode: "GB" });
    expect((await call(cart())).body).toMatchObject({
      available_buyer_currencies: [{ code: "usd", label: "$ (US Dollars)" }],
      buyer_currency_quote: null,
    });
  });
});

describe("error answers", () => {
  const answer = async (params: Record<string, unknown>, headers: Record<string, string> = {}) =>
    (await calculateAll({ params, request: requestWith(headers) })) as {
      status: number;
      body: string;
      contentType: string;
    };

  it("answers malformed products with an empty 400 typed by the request format", async () => {
    for (const products of ["not-an-array", ["abc"], { permalink: "abc" }]) {
      expect(await answer({ products }, { accept: "application/json" })).toMatchObject({
        status: 400,
        body: "",
        contentType: "application/json",
      });
    }
    expect(await answer({ products: ["abc"] })).toMatchObject({ status: 400, body: "", contentType: "text/html" });
  });

  it("types the empty 400 of a registered format param by that format", async () => {
    const answerWithFormat = async (format: string) =>
      (await calculateAll({
        params: { products: ["abc"] },
        request: requestWith({ accept: "application/json" }, `format=${format}`),
      })) as { status: number; body: string; contentType: string };

    expect(await answerWithFormat("xml")).toMatchObject({ status: 400, body: "", contentType: "application/xml" });
    expect(await answerWithFormat("text")).toMatchObject({ status: 400, body: "", contentType: "text/plain" });
    expect(await answerWithFormat("js")).toMatchObject({ status: 400, body: "", contentType: "text/javascript" });
  });

  it("answers an untrustworthy exchange rate with an empty 503", async () => {
    links = [link({ price_currency_type: "eur" })];
    getRate.mockRejectedValue(new RateUnavailable("EUR"));

    expect(await answer(cart(), { accept: "application/json" })).toMatchObject({
      status: 503,
      body: "",
      contentType: "application/json",
    });
  });
});

describe("hand-backs", () => {
  const expectHandBack = async (params: Record<string, unknown>) => {
    await expect(rejection(params)).rejects.toBeInstanceOf(HandBackToRails);
  };

  it("hands back a missing or empty products param", async () => {
    await expectHandBack({});
    await expectHandBack({ products: [] });
  });

  it("hands back a VAT id a vendor checks, a Payment Element request and a list token", async () => {
    await expectHandBack(cart({ vat_id: "IE6388047V" }));
    await expectHandBack(cart({ vat_id: "IE6388047V", country: "DE" }));
    await expectHandBack(cart({ vat_id: "123456789", country: "SG" }));
    await expectHandBack(cart({ vat_id: "NO123456789MVA", country: "NO" }));
    await expectHandBack(cart({ vat_id: "1234", country: "CA", state: "QC" }));
    await expectHandBack(cart({ vat_id: 12 }));
    await expectHandBack(cart({ payment_details_source: "payment_element" }));
    await expectHandBack(cart({ payment_element_direct_listed_currency: "eur" }));
    await expectHandBack(cart({ payment_method_list_token: "token" }));
  });

  it("serves a blank VAT id", async () => {
    expect((await call(cart({ vat_id: "  " }))).status).toBe(200);
  });

  it("hands back commission and renewal lines", async () => {
    links = [link({ native_type: "commission" })];
    await expectHandBack(cart());
    links = [link()];
    await expectHandBack(cart({}, { permalink: "abc", price: 100, subscription_id: "sub" }));
  });

  it("serves a line that declines installments", async () => {
    expect((await call(cart({}, { permalink: "abc", price: 100, pay_in_installments: false }))).status).toBe(200);
  });

  describe("TaxJar buyers", () => {
    it("taxes a US taxable state from TaxJar's amount and sends the line to it", async () => {
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 1.025 });
      const { body } = await call(
        cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 1000, quantity: 2 }),
      );

      expect(body).toMatchObject({ tax_cents: 102, has_vat_id_input: false, charge_canonical_total_cents: 1102 });
      expect(taxjar.mock.calls[0]![0]).toMatchObject({
        destinationCountry: "US",
        destinationState: "NY",
        destinationZip: "10001",
        quantity: 2,
        unitPriceDollars: 5,
        shippingDollars: 0,
        productTaxCode: "31000",
      });
    });

    it("sends no zip for a Canadian province and offers a tax id input in Quebec only", async () => {
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 2 });
      expect((await call(cart({ country: "CA", state: "BC" }))).body).toMatchObject({
        tax_cents: 200,
        has_vat_id_input: false,
      });
      expect(taxjar.mock.calls[0]![0]).toMatchObject({ destinationZip: null, destinationState: "BC" });
      expect((await call(cart({ country: "CA", state: "QC" }))).body).toMatchObject({
        tax_cents: 200,
        has_vat_id_input: true,
      });
    });

    it("falls back to the lookup table when TaxJar cannot answer", async () => {
      taxjar.mockResolvedValue({ kind: "fallback" });
      rates = [zipTaxRate({ country: "US", combined_rate: "0.0650000" })];
      expect(
        (await call(cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 1000, quantity: 1 })))
          .body,
      ).toMatchObject({
        tax_cents: 65,
        has_vat_id_input: false,
      });
      rates = [zipTaxRate({ country: "CA", combined_rate: "0.1200000" })];
      expect(
        (await call(cart({ country: "CA", state: "BC" }, { permalink: "abc", price: 1000, quantity: 1 }))).body,
      ).toMatchObject({
        tax_cents: 120,
      });
    });

    it("hands back what TaxJar answered that Rails alone can handle", async () => {
      taxjar.mockResolvedValue({ kind: "unsupported", reason: "a TaxJar answer with status 429" });
      await expectHandBack(cart({ country: "US", postal_code: "10001" }));
    });

    it.each([undefined, 0, -1, 1.5, "abc", null])("hands back a TaxJar buyer with quantity %s", async (quantity) => {
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 1 });
      await expectHandBack(cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 100, quantity }));
    });

    it("reads a string quantity", async () => {
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 1 });
      await call(cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 300, quantity: "3" }));
      expect(taxjar.mock.calls[0]![0]).toMatchObject({ quantity: 3, unitPriceDollars: 1 });
    });

    it("asks the software subtree for a SaaS tax code", async () => {
      links = [link({ taxonomy_id: 7n })];
      selectRows.mockImplementation(async (query: { sql: string }) => {
        if (query.sql.includes("FROM `links`")) return links;
        if (query.sql.includes("FROM `taxonomies`")) return [{ found: 1 }];
        return [];
      });
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 0 });
      await call(cart({ country: "US", postal_code: "10001" }));
      expect(taxjar.mock.calls[0]![0]).toMatchObject({ productTaxCode: "30070" });
    });

    it("does not reach TaxJar for a buyer outside the TaxJar regions whose tax id is invalid", async () => {
      taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 1 });
      expect((await call(cart({ country: "BH", vat_id: "x" }))).body).toMatchObject({ vat_id_valid: false });
      expect(taxjar).not.toHaveBeenCalled();
    });
  });

  describe("tax ids with a local validator", () => {
    it.each([
      ["BH", "123456789012345"],
      ["KE", "A123456789Z"],
      ["NG", "12345678-1234"],
      ["TZ", "12-345678-A"],
      ["OM", "OM1234567890"],
    ])("zeroes the tax and marks a valid %s id valid", async (country, vatId) => {
      expect((await call(cart({ country, vat_id: vatId }))).body).toMatchObject({ vat_id_valid: true, tax_cents: 0 });
      expect((await call(cart({ country, vat_id: "bad" }))).body).toMatchObject({ vat_id_valid: false });
    });

    it("does not validate the id of a free line", async () => {
      expect(
        (await call(cart({ country: "BH", vat_id: "123456789012345" }, { permalink: "abc", price: 0 }))).body,
      ).toMatchObject({
        vat_id_valid: false,
      });
    });
  });

  it("serves a US buyer outside the taxable states and a Canadian one without a province", async () => {
    expect((await call(cart({ country: "US", postal_code: "94104" }))).status).toBe(200);
    expect((await call(cart({ country: "CA" }))).status).toBe(200);
  });

  it("does not reach TaxJar for a free line", async () => {
    expect((await call(cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 0 }))).status).toBe(
      200,
    );
  });

  it("hands back a Spanish buyer placed in the Canary Islands", async () => {
    rates = [zipTaxRate({ country: "ES" })];
    geoIpLookup.mockReturnValue({ countryCode: "ES", regionName: "TF" });
    await expectHandBack(cart({ country: "ES", postal_code: "08001" }));

    geoIpLookup.mockReturnValue(null);
    expect((await call(cart({ country: "ES", postal_code: "35001" }))).body).toMatchObject({ tax_cents: 0 });
  });

  describe("a bundle bound for an EU rate", () => {
    const component = (...names: (keyof typeof FLAG_BITS)[]) => ({ product_id: 9n, flags: flagsOf(...names) });
    const taxFor = async () => (await call(cart({ country: "DE" }))).body.tax_cents;

    beforeEach(() => {
      rates = [zipTaxRate()];
      links = [link({ flags: flagsOf("is_bundle") })];
    });

    it("drops the VAT when every live component is physical", async () => {
      bundleComponents = [component("is_physical"), component("is_physical")];

      expect(await taxFor()).toBe(0);
    });

    it("keeps collecting for a mixed bundle and for one with no live component", async () => {
      bundleComponents = [component("is_physical"), component()];
      expect(await taxFor()).toBe(19);

      bundleComponents = [];
      expect(await taxFor()).toBe(19);
    });

    it("ignores the bundle row's own is_physical flag", async () => {
      links = [link({ flags: flagsOf("is_bundle", "is_physical") })];
      bundleComponents = [component()];

      expect(await taxFor()).toBe(19);
    });

    it("does not read the components for a seller's own rate or a destination outside the EU-27", async () => {
      rates = [zipTaxRate({ user_id: 5n })];
      bundleComponents = [component("is_physical")];
      expect(await taxFor()).toBe(19);

      rates = [zipTaxRate({ country: "AU", combined_rate: "0.1000000" })];
      expect((await call(cart({ country: "AU" }))).body.tax_cents).toBe(10);
      expect(selectRows.mock.calls.some(([query]) => (query as { sql: string }).sql.includes("bundle_products"))).toBe(
        false,
      );
    });

    it("hands back a bundle with a component whose product row is gone", async () => {
      bundleComponents = [{ product_id: null, flags: null }];

      await expectHandBack(cart({ country: "DE" }));
    });
  });

  it("hands back a seller using buyer-currency charging", async () => {
    isFeatureEnabled.mockResolvedValue(true);
    await expectHandBack(cart());
  });

  it("hands back a request format whose content type is not modelled", async () => {
    await expect(
      calculateAll({ params: { products: "x" }, request: requestWith({}, "format=nonsense") }),
    ).rejects.toBeInstanceOf(HandBackToRails);
    await expect(
      calculateAll({
        params: { products: "x" },
        request: requestWith({ "x-requested-with": "XMLHttpRequest", "content-type": "application/json" }),
      }),
    ).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("serves an unrecognized GeoIP address", async () => {
    geoIpLookup.mockReturnValue({ countryCode: null });

    expect((await call(cart())).body).toMatchObject({ detected_buyer_currency: null });
  });

  it("hands back a Brazilian Connect seller's tax", async () => {
    hasBrazilianStripeConnectAccount.mockRejectedValue(new HandBackToRails("brazil"));

    await expectHandBack(cart());
  });
});

const expectHandBack = async (params: Record<string, unknown>) => {
  await expect(rejection(params)).rejects.toBeInstanceOf(HandBackToRails);
};

describe("preorder, membership and installment lines", () => {
  let plans: Record<string, unknown>[];
  beforeEach(() => {
    plans = [];
    rates = [zipTaxRate()];
    selectRows.mockImplementation(async (query: { sql: string }) => {
      if (query.sql.includes("FROM `links`")) return links;
      if (query.sql.includes("FROM `zip_tax_rates`")) return rates;
      if (query.sql.includes("FROM `product_installment_plans`")) return plans;
      return [];
    });
  });
  const german = { country: "DE", postal_code: "10115" };

  it("totals a preorder in full but charges nothing now", async () => {
    links = [link({ flags: flagsOf("is_in_preorder_state") })];

    expect((await call(cart(german, { permalink: "abc", price: 1000, quantity: 1 }))).body).toMatchObject({
      subtotal: 1000,
      tax_cents: 190,
      charge_canonical_total_cents: 0,
      commission_completion_canonical_total_cents: 0,
    });
  });

  it("serves a preorder whose product is a commission without the deposit split", async () => {
    links = [link({ flags: flagsOf("is_in_preorder_state"), native_type: "commission" })];

    expect((await call(cart())).body).toMatchObject({ charge_canonical_total_cents: 0 });
  });

  it("charges a membership like a one-time line", async () => {
    links = [link({ flags: flagsOf("is_recurring_billing") })];

    expect((await call(cart(german, { permalink: "abc", price: 1000, quantity: 1 }))).body).toMatchObject({
      subtotal: 1000,
      tax_cents: 190,
      charge_canonical_total_cents: 1190,
    });
  });

  it("charges the first installment, taxed on its own, and totals the full price", async () => {
    plans = [{ number_of_installments: 3 }];
    const line = { permalink: "abc", price: 1000, quantity: 1, pay_in_installments: true };

    // 1000 / 3 = 333 remainder 1: the first payment is 334, taxed at 19% = 63.46 -> 63.
    expect((await call(cart(german, line))).body).toMatchObject({
      subtotal: 1000,
      tax_cents: 190,
      charge_canonical_total_cents: 397,
    });
  });

  it("charges the whole tip with the first installment", async () => {
    plans = [{ number_of_installments: 3 }];
    const line = { permalink: "abc", price: 1000, quantity: 1, pay_in_installments: "true", tip_cents: "100" };

    // Base 900 -> first 300, plus the 100 tip = 400, taxed at 19% = 76.
    expect((await call(cart(german, line))).body).toMatchObject({ charge_canonical_total_cents: 476 });
  });

  it("clamps a tip to the price and reads a non-numeric tip as 0", async () => {
    plans = [{ number_of_installments: 2 }];
    const clamped = { permalink: "abc", price: 1000, quantity: 1, pay_in_installments: true };

    expect((await call(cart({}, { ...clamped, tip_cents: 5000 }))).body).toMatchObject({
      charge_canonical_total_cents: 1000,
    });
    expect((await call(cart({}, { ...clamped, tip_cents: { a: 1 } }))).body).toMatchObject({
      charge_canonical_total_cents: 500,
    });
  });

  it("charges the full price when the product has no installment plan", async () => {
    const line = { permalink: "abc", price: 1000, quantity: 1, pay_in_installments: true };

    expect((await call(cart({}, line))).body).toMatchObject({ charge_canonical_total_cents: 1000 });
  });

  it("charges no tax or shipping now for a preorder line", async () => {
    plans = [{ number_of_installments: 2 }];
    links = [link({ flags: flagsOf("is_in_preorder_state") })];

    expect((await call(cart())).body).toMatchObject({ shipping_rate_cents: 0, charge_canonical_total_cents: 0 });
  });

  it("hands back a tip whose digits Ruby would join", async () => {
    plans = [{ number_of_installments: 2 }];
    const line = { permalink: "abc", price: 1000, quantity: 1, pay_in_installments: true, tip_cents: "1_0" };

    await expect(rejection(cart({}, line))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("Singapore and Spanish rates", () => {
  const year = new Date().getUTCFullYear();
  const sgRate = (years: unknown, extra: Record<string, unknown> = {}) =>
    zipTaxRate({
      country: "SG",
      combined_rate: "0.0900000",
      json_data: JSON.stringify({ applicable_years: years }),
      ...extra,
    });

  it("taxes a Singapore buyer with the rate listing the current year", async () => {
    rates = [sgRate([year - 1], { id: 1, combined_rate: "0.0800000" }), sgRate([year], { id: 2 })];

    expect((await call(cart({ country: "SG" }))).body).toMatchObject({ tax_cents: 9, has_vat_id_input: true });
  });

  it("falls back to the rate with the latest year when none lists the current year", async () => {
    rates = [sgRate([2001], { combined_rate: "0.0700000" }), sgRate([2003, 2002], { combined_rate: "0.0800000" })];

    expect((await call(cart({ country: "SG" }))).body).toMatchObject({ tax_cents: 8 });
  });

  it("charges no Singapore tax without a rate", async () => {
    expect((await call(cart({ country: "SG" }))).body).toMatchObject({ tax_cents: 0, has_vat_id_input: false });
  });

  it("takes the later-created of two Singapore rates tied on their latest year", async () => {
    rates = [sgRate([2001], { combined_rate: "0.0700000" }), sgRate([2001], { combined_rate: "0.0800000" })];

    expect((await call(cart({ country: "SG" }))).body).toMatchObject({ tax_cents: 8 });
  });

  it("hands back a Singapore rate table Ruby could not order", async () => {
    rates = [sgRate([2001]), sgRate([2001]), sgRate([2001])];
    await expectHandBack(cart({ country: "SG" }));

    rates = [sgRate([]), sgRate([]), sgRate([])];
    await expectHandBack(cart({ country: "SG" }));

    rates = [sgRate([], { combined_rate: "0.0700000" }), sgRate([], { combined_rate: "0.0800000" })];
    await expectHandBack(cart({ country: "SG" }));

    rates = [sgRate([]), sgRate([2001])];
    await expectHandBack(cart({ country: "SG" }));

    rates = [sgRate(null)];
    await expectHandBack(cart({ country: "SG" }));

    rates = [sgRate([2001], { json_data: null })];
    await expectHandBack(cart({ country: "SG" }));
  });

  it("taxes a Spanish buyer without a GeoIP record", async () => {
    rates = [zipTaxRate({ country: "ES", combined_rate: "0.2100000" })];

    expect((await call(cart({ country: "ES", postal_code: "08001" }))).body).toMatchObject({ tax_cents: 21 });
  });
});

describe("physical lines", () => {
  let destinations: Record<string, unknown>[];
  let exclusions: Record<string, unknown>[];
  const destination = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    country_code: "US",
    one_item_rate_cents: 500,
    multiple_items_rate_cents: 200,
    flags: 0,
    ...extra,
  });
  const physical = (extra: Record<string, unknown> = {}) => link({ flags: flagsOf("is_physical"), ...extra });

  beforeEach(() => {
    links = [physical()];
    destinations = [];
    exclusions = [];
    selectRows.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes("FROM `links`")) return links;
      if (query.sql.includes("FROM `zip_tax_rates`")) return rates;
      if (query.sql.includes("FROM `shipping_exclusions`")) return exclusions;
      if (query.sql.includes("FROM `shipping_destinations`")) {
        const virtual = query.sql.includes("`flags`");
        const code = virtual ? null : query.values.find((value) => typeof value === "string")!;
        return destinations.filter((row) =>
          virtual
            ? (Number(row.flags) & 1) !== 0 && query.values.includes(row.country_code)
            : row.country_code === code,
        );
      }
      return [];
    });
  });

  const cartOf = (quantity: unknown, extra: Record<string, unknown> = {}) =>
    cart({ country: "US", postal_code: "94104", ...extra }, { permalink: "abc", price: 1000, quantity });

  it("adds the one item rate and the multiple items rate for the rest", async () => {
    destinations = [destination()];

    expect((await call(cartOf(3))).body).toMatchObject({
      shipping_rate_cents: 900,
      subtotal: 1000,
      charge_canonical_total_cents: 1900,
    });
  });

  it("reads a string quantity like to_i", async () => {
    destinations = [destination()];

    expect((await call(cartOf("2"))).body).toMatchObject({ shipping_rate_cents: 700 });
  });

  it("charges no shipping for a quantity below one", async () => {
    destinations = [destination()];

    expect((await call(cartOf(0))).body).toMatchObject({ shipping_rate_cents: 0 });
  });

  it("falls back to the ELSEWHERE destination", async () => {
    destinations = [destination({ country_code: "ELSEWHERE", one_item_rate_cents: 800 })];

    expect((await call(cartOf(1))).body).toMatchObject({ shipping_rate_cents: 800 });
  });

  it("charges no shipping to an excluded or unserved country, or without a country", async () => {
    destinations = [destination()];
    exclusions = [{ excluded: 1 }];
    expect((await call(cartOf(1))).body).toMatchObject({ shipping_rate_cents: 0 });

    exclusions = [];
    destinations = [destination({ country_code: "CA" })];
    expect((await call(cartOf(1))).body).toMatchObject({ shipping_rate_cents: 0 });

    expect((await call(cart({}, { permalink: "abc", price: 1000, quantity: 1 }))).body).toMatchObject({
      shipping_rate_cents: 0,
    });
  });

  it("converts each rate term from the listed currency with one rate", async () => {
    links = [physical({ price_currency_type: "eur" })];
    destinations = [destination({ one_item_rate_cents: 300, multiple_items_rate_cents: 100 })];

    // 300 / 1.5 = 200 and 200 / 1.5 = 133.33 -> 133
    expect((await call(cartOf(3))).body).toMatchObject({ shipping_rate_cents: 333 });
    expect(getRate).toHaveBeenCalledTimes(1);
  });

  it("ships to a country through its continent destination", async () => {
    destinations = [destination({ country_code: "NORTH AMERICA", flags: 1, one_item_rate_cents: 650 })];
    expect((await call(cartOf(1, { country: "MX", postal_code: "01000" }))).body).toMatchObject({
      shipping_rate_cents: 650,
    });
  });

  it("prefers an exact country destination to a continent, and a continent to ELSEWHERE", async () => {
    destinations = [
      destination({ id: 1, country_code: "ELSEWHERE", one_item_rate_cents: 900 }),
      destination({ id: 2, country_code: "ASIA", flags: 1, one_item_rate_cents: 700 }),
    ];
    expect((await call(cartOf(1, { country: "JP", postal_code: "100-0001" }))).body).toMatchObject({
      shipping_rate_cents: 700,
    });
    destinations.push(destination({ id: 3, country_code: "JP", one_item_rate_cents: 400 }));
    expect((await call(cartOf(1, { country: "JP", postal_code: "100-0001" }))).body).toMatchObject({
      shipping_rate_cents: 400,
    });
  });

  it("ignores a continent destination for a country outside it, and one without the virtual-country flag", async () => {
    destinations = [
      destination({ country_code: "EUROPE", flags: 1, one_item_rate_cents: 650 }),
      destination({ country_code: "ELSEWHERE", one_item_rate_cents: 910 }),
    ];
    expect((await call(cartOf(1, { country: "AU", postal_code: "2000" }))).body).toMatchObject({
      shipping_rate_cents: 910,
    });
    destinations = [destination({ country_code: "ASIA", flags: 0, one_item_rate_cents: 650 })];
    expect((await call(cartOf(1, { country: "JP", postal_code: "100-0001" }))).body).toMatchObject({
      shipping_rate_cents: 0,
    });
  });

  it("sends a TaxJar buyer's shipping in dollars", async () => {
    links = [physical({ native_type: "physical" })];
    destinations = [destination()];
    taxjar.mockResolvedValue({ kind: "tax", amountToCollect: 0 });
    await call(cart({ country: "US", postal_code: "10001" }, { permalink: "abc", price: 1000, quantity: 3 }));
    expect(taxjar.mock.calls[0]![0]).toMatchObject({ shippingDollars: 9, productTaxCode: null });
  });

  it("hands back a fractional or missing quantity and a zero rate", async () => {
    destinations = [destination()];
    await expectHandBack(cartOf(1.5));
    await expectHandBack(cartOf(undefined));
    await expectHandBack(cartOf("two"));

    links = [physical({ price_currency_type: "eur" })];
    getRate.mockResolvedValue("0");
    await expectHandBack(cartOf(1));
  });

  it("treats the product as physical for the EU import carve-out", async () => {
    rates = [zipTaxRate()];
    destinations = [destination({ country_code: "DE" })];

    expect((await call(cartOf(1, { country: "DE", postal_code: "10115" }))).body).toMatchObject({
      tax_cents: 0,
      shipping_rate_cents: 500,
    });
  });

  it("still taxes a physical line bound for a non-EU rate", async () => {
    rates = [zipTaxRate({ country: "AU", combined_rate: "0.1000000" })];
    destinations = [destination({ country_code: "AU" })];

    expect((await call(cartOf(1, { country: "AU" }))).body).toMatchObject({ tax_cents: 100, shipping_rate_cents: 500 });
  });
});
