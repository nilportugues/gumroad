import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { renderSql } from "../../models/runtime/quoting.ts";
import { setSqlClient } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";

import { taxonomiesForNav } from "./taxonomies.ts";

// id, parent, slug, recent sales: "other" always sorts last and the rest by sales, then slug.
const TAXONOMIES = [
  { id: 1n, parent_id: null, slug: "design", recent_sales_count: 50 },
  { id: 2n, parent_id: null, slug: "films", recent_sales_count: 40 },
  { id: 3n, parent_id: null, slug: "3d", recent_sales_count: 30 },
  { id: 4n, parent_id: 3n, slug: "3d-modeling", recent_sales_count: 5 },
  { id: 5n, parent_id: null, slug: "other", recent_sales_count: 99 },
];
const sent: string[] = [];
let roots: { descendant_id: bigint; slug: string }[] = [];

beforeEach(() => {
  sent.length = 0;
  roots = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: Prisma.Sql) => {
      const sql = renderSql(query);
      sent.push(sql);
      return sql.includes("`taxonomy_hierarchies`") ? roots : TAXONOMIES;
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
});

const slugs = async (curated: bigint[]) => (await taxonomiesForNav(curated)).map((taxonomy) => taxonomy.slug);

describe("taxonomiesForNav", () => {
  it("lists the taxonomies by recent sales, with other last, when nothing is curated", async () => {
    expect(await slugs([])).toEqual(["design", "films", "3d", "3d-modeling", "other"]);
    expect(sent).toHaveLength(1);
  });

  it("moves the root of a curated taxonomy to the front, keeping the rest in their order", async () => {
    roots = [{ descendant_id: 2n, slug: "films" }];
    expect(await slugs([2n])).toEqual(["films", "design", "3d", "3d-modeling", "other"]);
  });

  it("orders the roots as the curated list does", async () => {
    roots = [
      { descendant_id: 2n, slug: "films" },
      { descendant_id: 4n, slug: "3d" },
    ];
    expect(await slugs([2n, 4n, 2n])).toEqual(["films", "3d", "design", "3d-modeling", "other"]);
  });

  it("ignores a repeated taxonomy after its first place", async () => {
    roots = [
      { descendant_id: 2n, slug: "films" },
      { descendant_id: 1n, slug: "design" },
    ];
    expect(await slugs([2n, 2n, 1n])).toEqual(["films", "design", "3d", "3d-modeling", "other"]);
    expect(await slugs([1n, 2n, 1n])).toEqual(["design", "films", "3d", "3d-modeling", "other"]);
  });

  it("looks the root of each distinct curated taxonomy up through the hierarchy table", async () => {
    roots = [{ descendant_id: 4n, slug: "3d" }];
    await slugs([4n, 4n]);
    expect(sent[1]).toContain("INNER JOIN `taxonomies` ON `taxonomies`.`id` = `taxonomy_hierarchies`.`ancestor_id`");
    expect(sent[1]).toContain("`taxonomy_hierarchies`.`descendant_id` = 4 AND `taxonomies`.`parent_id` IS NULL");
  });

  it("hands back a curated taxonomy with no root ancestor, where Rails' find raises", async () => {
    roots = [{ descendant_id: 2n, slug: "films" }];
    await expect(taxonomiesForNav([2n, 4n])).rejects.toBeInstanceOf(NotPortedError);
  });
});
