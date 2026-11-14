import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "pjson1-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { directAffiliateFields, ownAffiliateCreditCents } = await import("./purchase-json.ts");

const collaborator = { id: 7n, type: "Collaborator" };
const direct = { id: 8n, type: "DirectAffiliate" };
const sale = (jsonData: unknown, credit = 100) => ({
  affiliate_credit_cents: credit,
  json_data: jsonData === null ? null : JSON.stringify(jsonData),
});

describe("ownAffiliateCreditCents", () => {
  it("takes the direct affiliate's part off a collaborator sale that credits one", () => {
    const purchase = sale({ direct_affiliate_id: 8, direct_affiliate_credit_cents: 40 });

    expect(ownAffiliateCreditCents(purchase, collaborator, direct)).toBe(60);
  });

  it("reads a numeral id and a numeral credit as Integer#to_i does", () => {
    const purchase = sale({ direct_affiliate_id: "8", direct_affiliate_credit_cents: "25" });

    expect(ownAffiliateCreditCents(purchase, collaborator, direct)).toBe(75);
  });

  it("keeps the whole credit when the direct affiliate is gone, is not a DirectAffiliate or the affiliate is no collaborator", () => {
    const purchase = sale({ direct_affiliate_id: 8, direct_affiliate_credit_cents: 40 });

    expect(ownAffiliateCreditCents(purchase, collaborator, undefined)).toBe(100);
    expect(ownAffiliateCreditCents(purchase, collaborator, { id: 8n, type: "Collaborator" })).toBe(100);
    expect(ownAffiliateCreditCents(purchase, { id: 7n, type: "DirectAffiliate" }, direct)).toBe(100);
    expect(ownAffiliateCreditCents(sale(null), collaborator, direct)).toBe(100);
  });

  it("hands back a credit that is not an integer", () => {
    const purchase = sale({ direct_affiliate_id: 8, direct_affiliate_credit_cents: 40.5 });

    expect(() => ownAffiliateCreditCents(purchase, collaborator, direct)).toThrow(/shape the port does not read/u);
  });
});

describe("directAffiliateFields", () => {
  it("treats a missing, null, false or blank id as not recorded and keeps 0, which Ruby calls present", () => {
    expect(directAffiliateFields(sale({})).id).toBeNull();
    expect(directAffiliateFields(sale({ direct_affiliate_id: null })).id).toBeNull();
    expect(directAffiliateFields(sale({ direct_affiliate_id: false })).id).toBeNull();
    expect(directAffiliateFields(sale({ direct_affiliate_id: " " })).id).toBeNull();
    expect(directAffiliateFields(sale({ direct_affiliate_id: 0 })).id).toBe("0");
  });

  it("hands back an id that is neither an integer nor a numeral, and json_data that is not JSON", () => {
    expect(() => directAffiliateFields(sale({ direct_affiliate_id: [1] }))).toThrow(/shape the port does not read/u);
    expect(() => directAffiliateFields({ json_data: "{" })).toThrow(/shape the port does not read/u);
  });
});
