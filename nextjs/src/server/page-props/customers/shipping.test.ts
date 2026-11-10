import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "customers-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { HandBackToRails } from "../../controllers/application-controller.ts";

import { calculatedTrackingUrl, physicalJson, shippingJson, shippingReading, skuOption } from "./shipping.ts";

const shipment = (overrides: Record<string, unknown> = {}) => ({
  tracking_url: null,
  tracking_number: null,
  carrier: null,
  shipped_at: null,
  ...overrides,
});

describe("Shipment#calculated_tracking_url", () => {
  it("keeps the seller's URL, stripped", () => {
    expect(calculatedTrackingUrl(shipment({ tracking_url: " https://track.example.com/a?b=1 " }))).toBe(
      "https://track.example.com/a?b=1",
    );
  });

  it("derives the carrier's form from a carrier and tracking number when the URL is blank", () => {
    expect(calculatedTrackingUrl(shipment({ tracking_url: "  ", carrier: "UPS", tracking_number: "1Z999" }))).toBe(
      "http://wwwapps.ups.com/WebTracking/processInputRequest?TypeOfInquiryNumber=T&InquiryNumber1=1Z999",
    );
  });

  it("is nil without a mapped carrier or a number", () => {
    expect(calculatedTrackingUrl(shipment())).toBeNull();
    expect(calculatedTrackingUrl(shipment({ carrier: "UPS" }))).toBeNull();
    expect(calculatedTrackingUrl(shipment({ carrier: "Acme", tracking_number: "1" }))).toBeNull();
  });

  it("is nil for a URL that is not display-safe", () => {
    for (const tracking_url of [
      "ftp://example.com/x",
      "see the carrier site",
      "javascript:alert(1)",
      "https://example.com/\u0001",
      `https://example.com/${"a".repeat(2100)}`,
    ])
      expect(calculatedTrackingUrl(shipment({ tracking_url }))).toBeNull();
  });

  it("hands back what the port cannot parse like Ruby's URI", () => {
    for (const tracking_url of [
      "https://example.com/a|b",
      "https://example.com/#a#b",
      "HTTPS://EXAMPLE.COM/",
      "https://exämple.com/",
    ])
      expect(() => calculatedTrackingUrl(shipment({ tracking_url }))).toThrow(HandBackToRails);
  });
});

describe("shipping reading", () => {
  const purchase = (overrides: Record<string, unknown> = {}) => ({
    id: 5,
    shipping_cents: 250,
    displayed_price_currency_type: "usd",
    rate_converted_to_usd: "1.0",
    subscription_id: null,
    full_name: "Ann Buyer",
    street_address: "1 Main St",
    country: "United States",
    state: "CA",
    zip_code: null,
    city: "SF",
    ...overrides,
  });
  const link = { price_currency_type: "usd" };
  const known = () => true;

  it("formats the shipping in the purchase currency", async () => {
    expect((await shippingReading(purchase(), link, undefined, null, known)).price).toBe("$2.50");
    expect((await shippingReading(purchase({ shipping_cents: 99 }), link, undefined, null, known)).price).toBe("99¢");
    expect(
      (
        await shippingReading(
          purchase({ shipping_cents: 400, displayed_price_currency_type: "eur", rate_converted_to_usd: "0.5" }),
          { price_currency_type: "eur" },
          { recurrence: null },
          null,
          known,
        )
      ).price,
    ).toBe("€2");
  });

  it("hands back a subscription, a recurring price and a currency without a stored rate", async () => {
    await expect(shippingReading(purchase({ subscription_id: 1 }), link, undefined, null, known)).rejects.toThrow(
      HandBackToRails,
    );
    await expect(shippingReading(purchase(), link, { recurrence: "monthly" }, null, known)).rejects.toThrow(
      HandBackToRails,
    );
    await expect(
      shippingReading(purchase(), { price_currency_type: "eur" }, undefined, null, () => false),
    ).rejects.toThrow(HandBackToRails);
  });

  it("lays out the address in the order Rails builds it, with empty strings for missing parts", async () => {
    const reading = await shippingReading(purchase(), link, undefined, null, known);
    const json = shippingJson(purchase(), reading, true);
    expect(Object.entries(json.address)).toEqual([
      ["full_name", "Ann Buyer"],
      ["street_address", "1 Main St"],
      ["country", "United States"],
      ["state", "CA"],
      ["zip_code", ""],
      ["city", "SF"],
    ]);
    expect(json.tracking).toEqual({ shipped: false });
  });

  it("reports the shipment of a physical product and no tracking for a digital one", async () => {
    const shipped = shipment({ shipped_at: new Date(), tracking_url: "https://track.example.com/1" });
    const reading = await shippingReading(purchase(), link, undefined, shipped, known);
    expect(shippingJson(purchase(), reading, true).tracking).toEqual({
      shipped: true,
      url: "https://track.example.com/1",
    });
    expect(shippingJson(purchase(), reading, false).tracking).toBeNull();
    expect(
      shippingJson(purchase(), { ...reading, shipment: shipment({ tracking_url: "nope" }) }, true).tracking,
    ).toEqual({ shipped: false, url: null });
  });
});

describe("Sku on a customer", () => {
  const sku = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    name: "Large - Red",
    custom_sku: null,
    description: null,
    price_difference_cents: 100,
    max_purchase_count: 5,
    sales_count_for_inventory_cache: 7,
    duration_in_minutes: null,
    ...overrides,
  });

  it("names the sku by its custom name, else its external id", () => {
    expect(physicalJson({ id: 5 }, sku({ custom_sku: "RED-L" })).sku).toBe("RED-L");
    const fallback = physicalJson({ id: 5 }, sku({ custom_sku: " " }));
    expect(fallback.sku).not.toBe(" ");
    expect(fallback.order_number).toMatch(/^\d+$/u);
  });

  it("describes the option with its raw name and the stock left", () => {
    expect(skuOption(sku())).toMatchObject({
      name: "Large - Red",
      quantity_left: 0,
      description: "",
      price_difference_cents: 100,
      recurrence_price_values: null,
      is_pwyw: false,
    });
    expect(skuOption(sku({ max_purchase_count: null })).quantity_left).toBeNull();
  });
});
