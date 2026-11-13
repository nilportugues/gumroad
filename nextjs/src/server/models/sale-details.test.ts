import type { Purchase } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows, db } = vi.hoisted(() => ({
  selectRows: vi.fn(),
  db: { affiliate: { findUnique: vi.fn() }, user: { findUnique: vi.fn() } },
}));

vi.mock("../../lib/db.ts", () => ({ db }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: bigint) => `enc${id}` }));
vi.mock("./sql.ts", async (original) => ({ ...(await original<typeof import("./sql.ts")>()), selectRows }));

const { affiliateDetails, shipmentDetails, skuDetails } = await import("./sale-details.ts");
const { hasDirectAffiliateId } = await import("./json-direct-affiliate.ts");

const sale = (overrides: Partial<Purchase> = {}) =>
  ({
    id: 11n,
    full_name: " Jane Doe ",
    street_address: "1 Main St",
    city: "Town",
    state: "CA",
    zip_code: "94107",
    country: "United States",
    affiliate_id: null,
    affiliate_credit_cents: 0,
    json_data: null,
    ...overrides,
  }) as unknown as Purchase;

const sku = (overrides = {}) => ({ id: 5, name: "Large", custom_sku: null, flags: 0, link_id: 3, ...overrides });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("skuDetails", () => {
  it("keys the SKU under the title of the product's only category and prints its external id twice", async () => {
    selectRows.mockResolvedValue([{ title: "Size" }]);
    expect(await skuDetails(sku())).toEqual({
      variants: { Size: { is_sku: true, title: "Size", selected_variant: { id: "enc5", name: "Large" } } },
      sku: { id: "enc5", externalId: "enc5" },
    });
  });

  it("titles a SKU of a product with no category Version", async () => {
    selectRows.mockResolvedValue([]);
    const result = await skuDetails(sku());
    expect(Object.keys(result.variants)).toEqual(["Version"]);
  });

  it("prints the custom SKU as sku_id and leaves the external id alone", async () => {
    selectRows.mockResolvedValue([]);
    expect((await skuDetails(sku({ custom_sku: "LRG-1" }))).sku).toEqual({ id: "LRG-1", externalId: "enc5" });
  });

  it("falls back to the external id for a blank custom SKU", async () => {
    selectRows.mockResolvedValue([]);
    expect((await skuDetails(sku({ custom_sku: "  " }))).sku.id).toBe("enc5");
  });

  it("hands back a default SKU and a product with two categories", async () => {
    await expect(skuDetails(sku({ flags: 1 }))).rejects.toThrow("a default SKU");
    selectRows.mockResolvedValue([{ title: "Size" }, { title: "Color" }]);
    await expect(skuDetails(sku())).rejects.toThrow("several categories");
  });
});

describe("shipmentDetails", () => {
  it("answers null for a sale without a shipment", async () => {
    selectRows.mockResolvedValue([]);
    expect(await shipmentDetails(sale())).toBeNull();
  });

  it("prints shipped, the carrier's tracking link and the unstripped address", async () => {
    selectRows.mockResolvedValue([
      { shipped_at: new Date(), tracking_url: null, tracking_number: "1Z999", carrier: "UPS" },
    ]);
    expect(await shipmentDetails(sale())).toEqual({
      shipped: true,
      tracking_url: "http://wwwapps.ups.com/WebTracking/processInputRequest?TypeOfInquiryNumber=T&InquiryNumber1=1Z999",
      shipping_address: {
        full_name: " Jane Doe ",
        street_address: "1 Main St",
        city: "Town",
        state: "CA",
        zip_code: "94107",
        country: "United States",
      },
    });
  });

  it("prints a shipment that has not shipped and has no link", async () => {
    selectRows.mockResolvedValue([{ shipped_at: null, tracking_url: null, tracking_number: null, carrier: null }]);
    expect(await shipmentDetails(sale())).toMatchObject({ shipped: false, tracking_url: null });
  });

  it("hands back several shipments and a link URI.parse may read differently", async () => {
    const row = { shipped_at: null, tracking_url: null, tracking_number: null, carrier: null };
    selectRows.mockResolvedValue([row, row]);
    await expect(shipmentDetails(sale())).rejects.toThrow("several shipments");
    selectRows.mockResolvedValue([{ ...row, tracking_url: "ftp://example.com/track" }]);
    await expect(shipmentDetails(sale())).rejects.toThrow("URI.parse");
  });
});

describe("affiliateDetails", () => {
  const referred = (overrides: Partial<Purchase> = {}) =>
    sale({ affiliate_id: 9, affiliate_credit_cents: 150, ...overrides });

  it("answers null for a sale without an affiliate", async () => {
    expect(await affiliateDetails(sale())).toBeNull();
    expect(db.affiliate.findUnique).not.toHaveBeenCalled();
  });

  it("prints the unconfirmed email first and the credit with cents", async () => {
    db.affiliate.findUnique.mockResolvedValue({ affiliate_user_id: 4 });
    db.user.findUnique.mockResolvedValue({ email: "a@example.com", unconfirmed_email: "new@example.com" });
    expect(await affiliateDetails(referred({ affiliate_id: 9n }))).toEqual({
      email: "new@example.com",
      amount: "$1.50",
    });
    // Prisma types affiliates.id as Int and users.id as BigInt
    expect(db.affiliate.findUnique).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 4n } });
  });

  it("falls back to the confirmed email and drops the cents of a whole credit", async () => {
    db.affiliate.findUnique.mockResolvedValue({ affiliate_user_id: 4 });
    db.user.findUnique.mockResolvedValue({ email: "a@example.com", unconfirmed_email: "" });
    expect(await affiliateDetails(referred({ affiliate_credit_cents: 200 }))).toEqual({
      email: "a@example.com",
      amount: "$2",
    });
  });

  it("hands back a direct affiliate on a collaborator sale and an affiliate without a user", async () => {
    await expect(affiliateDetails(referred({ json_data: '{"direct_affiliate_id":7}' }))).rejects.toThrow(
      "direct affiliate",
    );
    db.affiliate.findUnique.mockResolvedValue({ affiliate_user_id: 4 });
    db.user.findUnique.mockResolvedValue(null);
    await expect(affiliateDetails(referred())).rejects.toThrow("user row is missing");
  });
});

describe("hasDirectAffiliateId", () => {
  it("reads the id out of json_data and ignores a blank one", () => {
    expect(hasDirectAffiliateId('{"direct_affiliate_id":7}')).toBe(true);
    expect(hasDirectAffiliateId('{"direct_affiliate_id":null}')).toBe(false);
    expect(hasDirectAffiliateId('{"direct_affiliate_id":""}')).toBe(false);
    expect(hasDirectAffiliateId('{"other":1}')).toBe(false);
    expect(hasDirectAffiliateId(null)).toBe(false);
    expect(hasDirectAffiliateId("")).toBe(false);
  });

  it("hands back json_data that is not JSON", () => {
    expect(() => hasDirectAffiliateId("{")).toThrow("not JSON");
  });
});
