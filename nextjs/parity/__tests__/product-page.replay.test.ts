import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import {
  bulkIndex,
  ELASTICSEARCH_HOST,
  recreateIndex,
  reindexProducts,
  reindexPurchases,
  replayIndexName,
  seededDocuments,
} from "../src/elasticsearch";
import { type Fixture, type FixtureRequest, loadFixture } from "../src/fixture";
import { railsOnlyKey } from "../src/rails-only";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// LinksController#show, recorded through the full Rack stack by spec/requests/product_page_parity_spec.rb.
// The port answers the redirects and 404s of the filters and hands a request that would render back to
// Rails, which a stand-in origin here marks.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/product_page_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const HANDED_BACK_STATUS = 218;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
const numericKey = "0";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity-ws77";

const COMPARE = {
  ignore: [
    // Added by the test environment's Rack stack, not by the app.
    "response.headers.x-original-headers-class",
    // Next.js owns Cache-Control on rendered HTML (no-store).
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.XSRF-TOKEN.value",
    // Minted per response.
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    "response.cookies.__profilin",
    "db.versions",
    // The port reads Elasticsearch itself; the recording's request log is not replayed.
    "http",
  ],
};

type Case = { name: string; file: string; index: number; served: boolean; status: number; ignore: string[] };

// The fixtures whose page the port renders (byte parity of status, headers, cookies and the Inertia page); every
// other request that would render is handed back to Rails and must reach the stand-in origin.
const RENDERED = new Set(
  [
    "renders-a-digital-product",
    "renders-a-product-whose-cover-is-a-youtube-video",
    "renders-a-product-whose-cover-is-a-vimeo-video-with-a-protocol-relative-player-and-a-cfb6aabe",
    "renders-a-product-whose-oembed-cover-reports-a-width-that-is-not-a-number",
    "renders-an-ebook-with-its-book-files-in-the-structured-data",
    "renders-a-euro-product-with-its-price-converted-to-dollars-in-the-structured-data",
    "renders-a-product-by-its-custom-permalink",
    "renders-a-tiered-membership-with-its-tiers",
    "renders-a-membership-with-a-free-trial",
    "renders-a-versioned-product",
    "renders-a-physical-product-with-skus",
    "shows-the-ratings-and-the-sales-count",
    "renders-a-bundle-with-its-products",
    "applies-the-code-query-parameter",
    "applies-the-offer-code-of-the-path",
    "reports-an-invalid-code",
    "shows-the-seller-s-auto-applied-sale",
    "marks-a-code-url-as-noindex",
    "renders-a-commission-product",
    "renders-a-preorder",
    "renders-a-pay-what-you-want-product",
    "renders-the-waitlist-of-an-unpublished-product-to-a-visitor",
    "renders-an-unpublished-product-with-a-noindex-header",
    "renders-a-deleted-product-with-a-noindex-header",
    "renders-an-adult-product",
    "shows-a-limited-quantity-remaining",
    "shows-the-product-s-refund-policy",
    "ignores-an-unknown-affiliate",
    "sets-the-affiliate-cookie-of-an-affiliate-id",
    "answers-an-inertia-visit-with-the-page-as-json",
    "credits-the-product-s-collaborator-as-a-co-creator",
    "does-not-credit-a-collaborator-who-opted-out-of-the-co-creator-credit-on-every-produc-f4bbdea1",
    "does-not-credit-a-collaborator-who-opted-out-of-the-co-creator-credit-on-this-product",
    "does-not-credit-a-collaborator-whose-invitation-is-still-pending",
    "renders-a-product-whose-covers-are-unsplash-photos",
    "renders-an-ebook-whose-cover-is-an-unsplash-photo",
    "renders-a-call-product",
    "renders-the-iframe-layout-for-embeds",
    "renders-the-iframe-layout-for-an-overlay",
    "renders-the-iframe-layout-of-a-call-product",
    "renders-the-profile-layout",
    "renders-the-profile-layout-with-an-offer-code-and-the-bundle-s-product-links",
    "prefers-the-layout-over-embed",
    "renders-the-standard-page-for-an-unknown-layout",
    "with-the-discover-layout-renders-the-taxonomy-path-and-the-navigation",
    "with-the-discover-layout-renders-a-product-without-a-taxonomy",
    "with-the-discover-layout-answers-the-search-box-s-autocomplete-request-with-the-sugge-b0c7b45c",
    "with-the-discover-layout-renders-a-storefront-seller-s-product-without-the-catalogue",
    "of-a-storefront-seller-answers-an-inertia-visit-with-the-profile-component",
    "of-a-storefront-seller-applies-the-visitor-s-filters-to-the-catalogue",
    "of-a-storefront-seller-keeps-a-hidden-header-of-a-saved-section-hidden",
    "of-a-storefront-seller-keeps-the-discover-layout-free-of-the-catalogue",
    "of-a-storefront-seller-keeps-the-embed-layout-free-of-the-catalogue",
    "of-a-storefront-seller-keeps-the-seller-s-own-view-standalone",
    "of-a-storefront-seller-leaves-a-sold-out-product-that-hides-its-sold-out-state-out-of-4974b277",
    "of-a-storefront-seller-shows-a-membership-with-tiers-in-the-catalogue",
    "of-a-storefront-seller-shows-an-empty-catalogue-when-the-viewed-product-is-the-only-o-a6deeddf",
    "of-a-storefront-seller-shows-the-rest-of-the-catalogue-under-the-product-headed-by-th-ab8d2025",
    "of-a-storefront-seller-shows-the-seller-s-saved-products-sections-instead-of-the-defa-aab4a520",
    "of-a-storefront-seller-shrinks-the-total-for-a-viewed-product-beyond-the-fetched-page",
    "of-a-storefront-seller-shrinks-the-total-for-a-viewed-product-on-the-fetched-page",
    "of-a-storefront-seller-wraps-the-profile-layout-with-the-catalogue-as-well",
    "arriving-from-discover-stores-a-click-of-a-signed-in-buyer-on-a-product-without-a-cat-545a35ed",
    "arriving-from-discover-stores-a-click-on-the-inertia-visit",
    "arriving-from-discover-stores-a-discover-click-that-carries-no-query",
    "arriving-from-discover-stores-a-search-click-on-the-product-with-the-product-s-own-ca-66fcb3a8",
    "arriving-from-discover-stores-an-autocomplete-click-without-a-suggestion",
    "arriving-from-discover-stores-nothing-for-a-crawler",
    "arriving-from-discover-stores-nothing-for-another-recommender",
    "arriving-from-discover-stores-nothing-while-the-flag-is-off",
  ]
    .map((name) => `on-a-seller-subdomain-${name}`)
    .concat(["on-a-product-s-custom-domain-renders-the-product-at-the-root", "signed-in-shows-the-seller-their-own-product-with-the-edit-controls", "signed-in-lists-the-posts-a-profile-section-could-show-in-the-seller-s-edit-controls", "signed-in-lists-the-viewer-s-wishlists-with-what-each-holds-of-the-product", "signed-in-shows-a-buyer-whose-purchase-was-refunded-the-product-without-a-purchase", "signed-in-counts-the-waitlist-of-an-unpublished-product-for-the-seller"]),
);

// The route gate (hostKindOf) sends a host that no alive seller owns to Rails whole: its catch-all is the 404. So does the root of a custom
// domain (Rack::Attack counts "/"), which railsOnlyKey recognises.
const GATE_HANDS_BACK = new Set(["product-page-on-a-seller-subdomain-is-a-404-for-a-product-of-a-deleted-seller"]);

// A 301 or 404, and the 302 to a coffee product's own page, are the filters' answers; the rest renders.
const cases: Case[] = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixture = loadFixture(path.join(DIR, file));
    const index = fixture.exchanges.length - 1;
    const response = fixture.exchanges[index]!.response;
    const served = response.status === 301 || response.status === 404 || (response.status === 302 && /\/coffee(\?|$)/u.test(response.location ?? ""));
    // The cookie's value is the time it was set.
    const affiliate = Object.keys(response.cookies ?? {}).filter((name) => name.startsWith("_gumroad_affiliate_id_"));
    const name = file.replace(/\.json$/u, "");
    return { name, file: path.join(DIR, file), index, served: (served || RENDERED.has(name.replace(/^product-page-/u, ""))) && !GATE_HANDS_BACK.has(name) && railsOnlyKey(fixture.exchanges[index]!.request) === null, status: response.status, ignore: affiliate.map((name) => `response.cookies.${name}.value`) };
  });

describe.skipIf(!url)("Product page parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((_, response) => {
      response.writeHead(HANDED_BACK_STATUS, { "x-handed-back": "rails" });
      response.end("handed back");
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: numericKey,
      NEXTJS_ROUTE_FLAGS: "nextjs_product_page",
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      SECRET_KEY_BASE,
      // The keys the test environment of the recording configured (.env.test).
      ...(envTest.match(/^(STRIPE_PUBLIC_KEY_TEST|RECAPTCHA_MONEY_SITE_KEY)=(.+)$/gmu) ?? []).reduce<Record<string, string>>((env, line) => {
        const [name, ...value] = line.split("=");
        return { ...env, [name!]: value.join("=") };
      }, {}),
      DATABASE_URL: url!,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => (rails ? rails.close(() => resolve()) : resolve()));
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.filter((c) => c.served).length).toBeGreaterThan(10);
    expect(cases.filter((c) => !c.served).length).toBeGreaterThan(4);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      const compare = { ...COMPARE, ignore: [...COMPARE.ignore, ...c.ignore, ...(c.status === 404 ? ["response.body"] : [])] };
      const options = {
        sql,
        redis: {
          async reset(entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0], exchange?: unknown, now?: Date) {
            await redisSeeder(redis).reset(entries);
            if (!exchange || !now) return;
            const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
            // Rails' `purchase-test` template index is dropped and rebuilt by every agent's spec run.
            for (let attempt = 0; ; attempt++) {
              try {
                await recreateIndex(es, purchases);
                break;
              } catch (error) {
                if (attempt >= 30 || !/index_not_found/u.test(String(error))) throw error;
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
            await reindexPurchases(es, purchases.name, sql);
            // The discover layout's autocomplete searches products and reads the visitor's page views.
            const products = { model: "Link", name: replayIndexName("products", ES_INDEX_SUFFIX) } as const;
            await recreateIndex(es, products);
            await reindexProducts(es, products.name, sql);
            const views = { model: "ProductPageView", name: replayIndexName("product_page_views", ES_INDEX_SUFFIX) } as const;
            await recreateIndex(es, views);
            await bulkIndex(es, views.name, seededDocuments(exchange as never, "ProductPageView", now).map((body) => ({ body })));
          },
        },
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request: FixtureRequest, fixture: Fixture, now: Date) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
      };
      if (!c.served) {
        // The request the filters cannot prove goes to Rails whole.
        const result = await replayFixtureExchange(c.file, c.index, { ...options, compare: { ignore: ["**"] } });
        const actual = result.exchanges[0]!.actual.response;
        expect(actual.status, server.output().slice(-2000)).toBe(HANDED_BACK_STATUS);
        return;
      }
      const result = await replayFixtureExchange(c.file, c.index, { ...options, compare });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /u.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
