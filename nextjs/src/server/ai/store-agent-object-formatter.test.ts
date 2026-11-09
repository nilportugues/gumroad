// Mirrors spec/services/ai/store_agent_object_formatter_spec.rb for the pure half; the offer code
// lookups the Ruby spec does through the database are exercised through the injected lookup.
import { describe, expect, it, vi } from "vitest";

import {
  type DisplayObject,
  fromResponse,
  humanSize,
  localTime,
  money,
  toSentence,
} from "./store-agent-object-formatter.ts";

const one = (...args: Parameters<typeof fromResponse>): DisplayObject => {
  const [card] = fromResponse(...args);
  if (!card) throw new Error("expected a display object");
  return card;
};
const label = (card: { fields: { label: string }[] }) => card.fields.map((field) => field.label);

describe("fromResponse", () => {
  it("returns an empty list for an error envelope", () => {
    expect(fromResponse("list_products", { success: false, message: "nope" })).toEqual([]);
  });

  it("returns an empty list for a non-hash response and unknown endpoints", () => {
    expect(fromResponse("list_products", "oops")).toEqual([]);
    expect(fromResponse("mystery", { success: true })).toEqual([]);
  });

  it("builds product cards from list_products", () => {
    const card = one("list_products", {
      success: true,
      products: [
        {
          id: "p1",
          name: "Cool Ebook",
          formatted_price: "$9.99",
          published: true,
          sales_count: 12,
          short_url: "https://x.gumroad.com/l/ebook",
        },
      ],
    });
    expect(card).toMatchObject({
      type: "product",
      title: "Cool Ebook",
      subtitle: "$9.99",
      url: "https://x.gumroad.com/l/ebook",
      copy: "https://x.gumroad.com/l/ebook",
    });
    expect(card.fields).toEqual(
      expect.arrayContaining([
        { label: "Status", value: "Published" },
        { label: "Sales", value: "12" },
      ]),
    );
  });

  it("builds a single product card from create_product", () => {
    const card = one("create_product", {
      success: true,
      product: { id: "p2", name: "New Thing", price: 2500, currency: "usd", published: false },
    });
    expect(card.subtitle).toBe("$25");
    expect(card.fields).toContainEqual({ label: "Status", value: "Unpublished" });
  });

  it("builds sale, payout, upsell, email, media and help article cards", () => {
    expect(
      fromResponse("get_sale", { sale: { id: "s1", email: "buyer@example.com", price: 500, refunded: false } })[0],
    ).toMatchObject({
      type: "sale",
      title: "buyer@example.com",
      subtitle: "$5",
      copy: "s1",
    });
    expect(
      fromResponse("list_payouts", { payouts: [{ id: "po1", amount_cents: 1250, status: "paid" }] })[0],
    ).toMatchObject({
      title: "$12.50",
      subtitle: "paid",
    });
    expect(
      fromResponse("get_upsell", {
        upsell: { id: "u1", name: "Bump", cross_sell: true, offer_code: { name: "X" } },
      })[0],
    ).toMatchObject({
      subtitle: "Cross-sell",
    });
    expect(one("get_email", { email: { id: "e1", subject: "Hi", published: false } })).toMatchObject({
      title: "Hi",
      subtitle: "Draft",
      copy: "e1",
    });
    expect(
      fromResponse("upload_media", {
        media: { id: "m1", name: "a.png", file_group: "image", file_size: 2048, url: "https://x" },
      })[0],
    ).toMatchObject({
      subtitle: "Image",
      copy: "https://x",
    });
    expect(
      fromResponse("get_help_article", { title: "Refunds", url: "https://help", category: "Sales" })[0],
    ).toMatchObject({
      type: "help_article",
      copy: "https://help",
    });
  });
});

describe("discount cards", () => {
  const percent = { id: "o1", name: "LAUNCH25", percent_off: 25, times_used: 3 };

  it("copies the code and renders the percentage once", () => {
    const card = one("create_offer_code", { success: true, offer_code: percent });
    expect(card).toMatchObject({
      type: "discount",
      title: "LAUNCH25",
      subtitle: "25% off",
      copy: "LAUNCH25",
      url: null,
    });
    expect(card.fields).toContainEqual({ label: "Times used", value: "3" });
    expect(label(card)).not.toContain("Applies to");
  });

  it("renders the stored currency and coverage from the lookup", () => {
    const card = one(
      "get_offer_code",
      { offer_code: { id: "o2", name: "FIVE", amount_cents: 500 } },
      { discountDetails: () => ({ o2: { currency: "eur", coverage: "EUR guide" } }) },
    );
    expect(card.subtitle).toBe("€5 off");
    expect(card.fields).toContainEqual({ label: "Applies to", value: "EUR guide" });
  });

  it("omits the fixed amount and coverage when the record cannot be verified", () => {
    const card = one(
      "get_offer_code",
      { offer_code: { id: "o3", name: "GONE", amount_cents: 500 } },
      { discountDetails: () => ({}) },
    );
    expect(card.subtitle).toBeNull();
    expect(label(card)).not.toContain("Applies to");
  });

  it("omits currency and coverage when there is no seller context", () => {
    const card = one("get_offer_code", { offer_code: { id: "o4", name: "NOSELLER", amount_cents: 500 } });
    expect(card.subtitle).toBeNull();
  });

  it("shows the auto apply fields and the default sale label", () => {
    const card = one("get_offer_code", {
      offer_code: { id: "o5", name: "AUTO", percent_off: 10, auto_apply: true },
    });
    expect(card.fields).toEqual(
      expect.arrayContaining([
        { label: "Apply automatically", value: "On" },
        { label: "Sale label", value: "Sale" },
      ]),
    );
  });

  it("formats validity dates in the seller's zone", () => {
    const card = one(
      "get_offer_code",
      { offer_code: { id: "o6", name: "DATES", percent_off: 10, valid_at: "2026-01-05T18:30:00Z" } },
      { timeZone: "America/Los_Angeles" },
    );
    expect(card.fields).toContainEqual({ label: "Starts at", value: "Jan 5, 2026, 10:30 AM PST" });
  });

  it("skips repeated cards without losing later unique cards or changed fields", () => {
    const lookup = vi.fn(() => ({ o1: { currency: null, coverage: null } }));
    const existing = one("list_offer_codes", { offer_codes: [percent] });
    const cards = fromResponse(
      "list_offer_codes",
      {
        offer_codes: [
          null,
          {},
          ...Array.from({ length: 100 }, () => percent),
          { ...percent, unused: true },
          { ...percent, times_used: 2 },
        ],
      },
      { limit: 1, existingObjects: [existing], discountDetails: lookup },
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.fields).toContainEqual({ label: "Times used", value: "2" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not look anything up when the display budget is exhausted", () => {
    const lookup = vi.fn(() => ({}));
    expect(fromResponse("list_offer_codes", { offer_codes: [percent] }, { limit: 0, discountDetails: lookup })).toEqual(
      [],
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("formats cents like the Ruby helper", () => {
    expect(money(2500, "usd")).toBe("$25");
    expect(money(1999)).toBe("$19.99");
    expect(money(500, "eur")).toBe("5 EUR");
    expect(money(null)).toBeNull();
  });

  it("falls back to the raw value for a non ISO 8601 time", () => {
    expect(localTime("next tuesday", null)).toBe("next tuesday");
    expect(localTime("", null)).toBe("");
  });

  it("humanizes file sizes", () => {
    expect(humanSize(512)).toBe("512 Bytes");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("joins words like to_sentence", () => {
    expect(toSentence([])).toBe("");
    expect(toSentence(["a", "b"])).toBe("a and b");
    expect(toSentence(["a", "b", "c"])).toBe("a, b, and c");
  });
});
