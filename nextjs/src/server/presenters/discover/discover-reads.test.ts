import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findLink: vi.fn(),
  findUser: vi.fn(),
  card: vi.fn(),
  thumbnail: vi.fn(),
  wishlistCard: vi.fn(),
  wishlists: [] as { id: bigint }[],
}));

vi.mock("../product-reads.ts", () => ({ findLink: mocks.findLink, findUserById: mocks.findUser }));
vi.mock("../product.ts", () => ({
  cardForWeb: mocks.card,
  longUrl: (row: { unique_permalink: string }, _seller: unknown, options: Record<string, unknown>) =>
    `https://x.example.com/l/${row.unique_permalink}?${JSON.stringify(options)}`,
}));
vi.mock("../../page-props/buyer/products.ts", () => ({ anyThumbnailUrl: mocks.thumbnail }));
vi.mock("../../page-props/storefront/featured-and-wishlist-sections.ts", () => ({
  wishlistCardProps: mocks.wishlistCard,
}));
vi.mock("../../../lib/db.ts", () => ({ db: { wishlist: { findMany: async () => mocks.wishlists } } }));

import { renderSql } from "../../models/runtime/quoting.ts";
import { setSqlClient } from "../../models/sql.ts";
import { recommendedWishlistIds, recommendedWishlistsProps } from "../../page-props/discover/recommended-wishlists.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { type EsRequest, setEsSender } from "../../search/transport.ts";

import { autocompleteProps } from "./autocomplete.ts";
import { anonymousKey, recentlyViewedProps } from "./recently-viewed.ts";

const sentSql: string[] = [];
let sqlRows: unknown[][] = [];
const sentEs: EsRequest[] = [];
let esResponses: unknown[] = [];
let restoreEs: (() => void) | undefined;

beforeEach(() => {
  sentSql.length = 0;
  sentEs.length = 0;
  sqlRows = [];
  esResponses = [];
  for (const mock of [mocks.findLink, mocks.findUser, mocks.card, mocks.thumbnail, mocks.wishlistCard])
    mock.mockReset();
  mocks.wishlists = [];
  setSqlClient(() => ({
    $queryRaw: (async (sql: Prisma.Sql) => {
      sentSql.push(renderSql(sql));
      return sqlRows.shift() ?? [];
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
  restoreEs = setEsSender(async (request) => {
    sentEs.push(request);
    return { status: 200, body: esResponses.shift() ?? { hits: { hits: [] } } };
  });
});
afterEach(() => restoreEs?.());

const hits = (...sources: Record<string, unknown>[]) => ({
  hits: { hits: sources.map((source) => ({ _id: String(source.product_id), _source: source })) },
});
const idHits = (...ids: number[]) => ({
  hits: { total: { value: ids.length }, hits: ids.map((id) => ({ _id: String(id) })) },
});

describe("Discover::AutocompletePresenter", () => {
  it("selects a signed-in user's last five distinct recent searches when the query is blank", async () => {
    sqlRows = [[{ query: "rig" }, { query: "film" }]];
    esResponses = [hits(), idHits()];
    const props = await autocompleteProps(undefined, { user: { id: 7n }, browserGuid: "guid" });
    expect(sentSql[0]).toBe(
      "SELECT `discover_searches`.`query` FROM `discover_search_suggestions` INNER JOIN `discover_searches` ON `discover_searches`.`id` = `discover_search_suggestions`.`discover_search_id` WHERE `discover_search_suggestions`.`deleted_at` IS NULL AND `discover_searches`.`user_id` = 7 GROUP BY `discover_searches`.`query` ORDER BY MAX(`discover_search_suggestions`.`created_at`) DESC, MAX(`discover_search_suggestions`.`id`) DESC LIMIT 5",
    );
    expect(props.recent_searches).toEqual(["rig", "film"]);
  });

  it("scopes an anonymous visitor's searches to the browser guid with no user", async () => {
    esResponses = [hits(), idHits()];
    await autocompleteProps("", { user: null, browserGuid: "guid" });
    expect(sentSql[0]).toContain(
      "`discover_searches`.`browser_guid` = 'guid' AND `discover_searches`.`user_id` IS NULL",
    );
  });

  it("filters the last hundred searches by the downcased query and keeps eight", async () => {
    sqlRows = [[{ query: "Rig kit" }, { query: "rig kit" }, { query: "blender" }, { query: "ri" }, { query: "Film" }]];
    esResponses = [idHits()];
    const props = await autocompleteProps("RIG", { user: { id: 7n }, browserGuid: null });
    expect(sentSql[0]).toMatch(/ LIMIT 100$/u);
    expect(sentSql[0]).not.toContain("DISTINCT");
    // "Rig kit" matches by word prefix, "ri" because the query starts with it; "rig kit" is a duplicate only after uniq.
    expect(props.recent_searches).toEqual(["Rig kit", "rig kit", "ri"]);
  });

  it("searches products by the partial query and builds long urls with the autocomplete flag", async () => {
    esResponses = [idHits(4, 9)];
    mocks.findLink.mockImplementation(async (id: bigint) =>
      id === 9n ? null : { id, name: "Rig kit", unique_permalink: "abc", user_id: 2n },
    );
    mocks.findUser.mockResolvedValue({ id: 2n, name: "  " });
    mocks.thumbnail.mockResolvedValue("https://img.example.com/t.png");
    const props = await autocompleteProps("Rig", { user: null, browserGuid: null });
    expect(JSON.parse(sentEs[0]!.body as string)).toMatchObject({
      size: 5,
      query: {
        bool: {
          must: [
            { simple_query_string: { query: "rig", fields: ["name", "name.ngrams"], default_operator: "and" } },
            { term: { is_recommendable: true } },
            { term: { rated_as_adult: false } },
          ],
        },
      },
    });
    expect(props.viewed).toBeUndefined();
    expect(props.products).toEqual([
      {
        name: "Rig kit",
        url: `https://x.example.com/l/abc?${JSON.stringify({ recommendedBy: "search", layout: "discover", query: "rig", autocomplete: true })}`,
        seller_name: null,
        thumbnail_url: "https://img.example.com/t.png",
      },
    ]);
  });

  it("shows the default products as not viewed for a visitor with no identity", async () => {
    esResponses = [idHits()];
    const props = await autocompleteProps("", { user: null, browserGuid: null });
    expect(sentEs).toHaveLength(1);
    expect(JSON.parse(sentEs[0]!.body as string).size).toBe(5);
    expect(props).toMatchObject({ products: [], viewed: false });
  });

  it("queries the visitor's last five page views and shows those products as viewed", async () => {
    esResponses = [hits({ product_id: 4 }, { product_id: 9 }), idHits(9, 4)];
    mocks.findLink.mockImplementation(async (id: bigint) => ({
      id,
      name: "P",
      unique_permalink: String(id),
      user_id: 2n,
    }));
    mocks.findUser.mockResolvedValue({ id: 2n, name: "Mara" });
    mocks.thumbnail.mockResolvedValue(null);
    const props = await autocompleteProps("", { user: null, browserGuid: "guid" });
    expect(sentEs[0]!.path).toMatch(/product_page_views.*\/_search$/u);
    expect(sentEs[0]!.body).toBe(
      '{"query":{"bool":{"must":{"term":{"browser_guid":"guid"}},"must_not":{"exists":{"field":"user_id"}}}},"sort":{"timestamp":"desc"},"size":5}',
    );
    expect(JSON.parse(sentEs[1]!.body as string).query.bool.must).toContainEqual({ terms: { _id: [4, 9] } });
    expect(props.viewed).toBe(true);
    expect(props.products.map((product) => product.seller_name)).toEqual(["Mara", "Mara"]);
  });

  it("falls back to the default products when the visitor has no page views", async () => {
    esResponses = [hits(), idHits()];
    expect((await autocompleteProps("", { user: { id: 7n }, browserGuid: null })).viewed).toBe(false);
    expect(sentEs[0]!.body).toBe(
      '{"query":{"bool":{"must":{"term":{"user_id":7}}}},"sort":{"timestamp":"desc"},"size":5}',
    );
  });
});

describe("Discover::RecentlyViewedPresenter", () => {
  const request = {
    host: "gumroad.com",
    hostWithPort: "gumroad.com",
    protocol: "https://",
    remoteIp: "127.0.0.1",
    params: {},
    cookies: new Map(),
  };
  const now = new Date("2026-11-09T12:00:00.123Z");

  it("keys an anonymous visitor by the first sixteen hex characters of the guid's SHA-256", () => {
    expect(anonymousKey("guid")).toBe("4b565f53a6d8d395");
  });

  it("returns nil without an identity", async () => {
    expect(await recentlyViewedProps({ user: null, browserGuid: null, request }, now)).toBeNull();
    expect(sentEs).toHaveLength(0);
  });

  it("collapses views by product over a thirty day window for a browser", async () => {
    esResponses = [hits()];
    expect(await recentlyViewedProps({ user: null, browserGuid: "guid", request }, now)).toBeNull();
    expect(sentEs[0]!.body).toBe(
      '{"query":{"bool":{"must":[{"term":{"browser_guid":"guid"}},{"range":{"timestamp":{"gte":"2026-10-10T12:00:00Z"}}}],"must_not":{"exists":{"field":"user_id"}}}},"collapse":{"field":"product_id"},"sort":{"timestamp":"desc"},"size":8}',
    );
  });

  it("keeps the first view per product, cards in view order, and drops products the search no longer returns", async () => {
    esResponses = [
      hits(
        { product_id: 4, timestamp: "t2" },
        { product_id: 4, timestamp: "t1" },
        { product_id: 9, timestamp: "t0" },
        { product_id: 11, timestamp: "tx" },
      ),
      idHits(9, 4),
    ];
    mocks.findLink.mockImplementation(async (id: bigint) => ({ id }));
    mocks.card.mockImplementation(async (id: bigint) => ({ id }));
    const props = await recentlyViewedProps(
      { user: { id: 7n }, browserGuid: "ignored", request, includeRatedAsAdult: true },
      now,
    );
    expect(sentEs[0]!.body).toContain('"must":[{"term":{"user_id":7}}');
    expect(JSON.parse(sentEs[1]!.body as string).query.bool.must).toContainEqual({ terms: { _id: [4, 9, 11] } });
    expect(props).toEqual({
      products: [
        { id: 4n, viewed_at: "t2" },
        { id: 9n, viewed_at: "t0" },
      ],
      anonymous_key: null,
    });
    expect(mocks.card.mock.calls[0]![1]).toMatchObject({
      recommendedBy: "recently_viewed",
      target: "discover",
      computeDescription: false,
    });
  });
});

describe("RecommendedWishlistsService", () => {
  it("orders recommendable wishlists by recent followers when there is no taxonomy", async () => {
    sqlRows = [[{ id: 3n }, { id: 1n }]];
    expect(await recommendedWishlistIds(null)).toEqual([3n, 1n]);
    expect(sentSql[0]).toBe(
      "SELECT `wishlists`.* FROM `wishlists` WHERE `wishlists`.`recommendable` = TRUE ORDER BY `wishlists`.`recent_follower_count` DESC LIMIT 4",
    );
  });

  it("takes distinct wishlists holding a product of the taxonomy from the top ten thousand", async () => {
    sqlRows = [[{ id: 3n }]];
    expect(await recommendedWishlistIds(5n)).toEqual([3n]);
    expect(sentSql[0]).toBe(
      "SELECT DISTINCT `wishlists`.* FROM (SELECT `wishlists`.* FROM `wishlists` WHERE `wishlists`.`recommendable` = TRUE ORDER BY `wishlists`.`recent_follower_count` DESC LIMIT 10000) `wishlists` INNER JOIN `wishlist_products` ON `wishlist_products`.`wishlist_id` = `wishlists`.`id` INNER JOIN `links` ON `links`.`id` = `wishlist_products`.`product_id` WHERE `links`.`taxonomy_id` = 5 LIMIT 4",
    );
  });

  it("hands back a taxonomy with no wishlists, where Rails' FIELD() ordering is a syntax error", async () => {
    await expect(recommendedWishlistIds(5n)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("builds a discover card per wishlist in the service's order", async () => {
    sqlRows = [[{ id: 3n }, { id: 1n }]];
    mocks.wishlists = [{ id: 1n }, { id: 3n }];
    mocks.wishlistCard.mockImplementation(async (wishlist: { id: bigint }) => ({ id: wishlist.id }));
    expect(await recommendedWishlistsProps(null)).toEqual([{ id: 3n }, { id: 1n }]);
    expect(mocks.wishlistCard.mock.calls[0]![1]).toEqual({ layout: "discover", recommendedBy: "discover_wishlist" });
  });
});
