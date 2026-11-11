import { beforeAll, describe, expect, it } from "vitest";

import { encryptNumeric } from "../../lib/obfuscate-ids.ts";

import { statisticsBody } from "./affiliate-statistics.ts";

describe("statisticsBody", () => {
  beforeAll(() => {
    process.env.OBFUSCATE_IDS_CIPHER_KEY = "affiliate-statistics-test-key";
    process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";
  });

  it("answers zero volume and no products for an affiliate without sales", () => {
    expect(statisticsBody([])).toBe('{"total_volume_cents":0,"products":{}}');
  });

  it("sums the volume and keeps the products in the order given", () => {
    const sales = [
      { linkId: 3, volumeCents: 700, salesCount: 2 },
      { linkId: 1, volumeCents: 500, salesCount: 1 },
    ];
    const [first, second] = sales.map(({ linkId }) => encryptNumeric(linkId));
    expect(statisticsBody(sales)).toBe(
      `{"total_volume_cents":1200,"products":{"${first}":{"volume_cents":700,"sales_count":2},"${second}":{"volume_cents":500,"sales_count":1}}}`,
    );
  });
});
