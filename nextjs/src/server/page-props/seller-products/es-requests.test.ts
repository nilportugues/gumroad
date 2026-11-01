// The Elasticsearch requests the products pages send, against the ones Rails sent in the recorded fixtures
// (their `http` channel keeps every request body): the same query for the same product, user and sums.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { activeCustomersOptions, earnedByUserOptions } from "./collabs.ts";
import { totalUsdCentsOptions } from "./dashboard-products.ts";

const FIXTURES = path.join(process.cwd(), "parity", "fixtures", "requests");

type Body = { query: { bool: { filter: Array<Record<string, any>> } }; aggs: Record<string, unknown> };
const requests: Body[] = [];
if (existsSync(FIXTURES)) {
  for (const dir of readdirSync(FIXTURES).filter((name) => /^seller_products_.*_spec$/.test(name))) {
    for (const file of readdirSync(path.join(FIXTURES, dir))) {
      const fixture = JSON.parse(readFileSync(path.join(FIXTURES, dir, file), "utf8")) as { exchanges: Array<{ http?: Array<{ url: string; body: string }> }> };
      for (const call of fixture.exchanges.flatMap((exchange) => exchange.http ?? [])) {
        if (!call.url.endsWith("/purchase-test/_search")) continue;
        const body = JSON.parse(call.body) as Body;
        // The seller totals of User#sales_cents_total (the new product page) have no product clause.
        if (body.query.bool.filter.some((clause) => "terms" in clause && "product_id" in clause.terms)) requests.push(body);
      }
    }
  }
}

const productIdOf = (body: Body) => (body.query.bool.filter.find((clause) => "terms" in clause && "product_id" in clause.terms)!.terms.product_id as number[])[0]!;
const has = (body: Body, aggregation: string) => aggregation in body.aggs;

describe("products pages Elasticsearch requests", () => {
  it("finds the recorded requests", () => {
    expect(requests.length).toBeGreaterThan(0);
  });

  it("builds the total_usd_cents request a product row sends", () => {
    const bodies = requests.filter((body) => has(body, "price_cents_total") && !has(body, "affiliate_cents_total"));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(new PurchaseSearchService(totalUsdCentsOptions(BigInt(productIdOf(body)))).body).toEqual(body);
  });

  it("builds the seller's earnings request of a collab", () => {
    const bodies = requests.filter((body) => has(body, "affiliate_cents_total"));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const sellerId = BigInt((body.query.bool.filter.find((clause) => "terms" in clause && "seller_id" in clause.terms)!.terms.seller_id as number[])[0]!);
      const { options } = earnedByUserOptions(BigInt(productIdOf(body)), sellerId, sellerId);
      expect(new PurchaseSearchService(options).body).toEqual(body);
    }
  });

  it("builds the collaborator's earnings request of a collab", () => {
    const bodies = requests.filter((body) => has(body, "affiliate_credit_amount_cents_own"));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const filter = body.query.bool.filter.find((clause) => "bool" in clause)!;
      const userId = BigInt(filter.bool.should[0].terms.affiliate_credit_affiliate_user_id[0]);
      const { options } = earnedByUserOptions(BigInt(productIdOf(body)), userId + 1n, userId);
      expect(new PurchaseSearchService(options).body).toEqual(body);
    }
  });

  it("builds the active customers request of the collabs stats", () => {
    const bodies = requests.filter((body) => has(body, "unique_email_count"));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(new PurchaseSearchService(activeCustomersOptions(BigInt(productIdOf(body)))).body).toEqual(body);
  });
});
