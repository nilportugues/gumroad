import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rubySortByInteger } from "./ruby-sort-by.ts";

type Golden = { views: number[]; order: number[] }[];
const golden = JSON.parse(
  readFileSync(new URL("../../../../parity/golden/ruby-sort-by-integer.json", import.meta.url), "utf8"),
) as Golden;

describe("rubySortByInteger", () => {
  it("orders rows with equal keys as Ruby's sort_by does", () => {
    const mismatches = golden.filter(
      ({ views, order }) =>
        JSON.stringify(
          rubySortByInteger(
            views.map((_, index) => index),
            (index) => -views[index]!,
          ),
        ) !== JSON.stringify(order),
    );

    expect(golden.length).toBeGreaterThan(300);
    expect(mismatches.map(({ views }) => views.length)).toEqual([]);
  });

  it("is not a stable sort, as Ruby's is not", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ index, views: index % 3 }));
    const sorted = rubySortByInteger(rows, (row) => -row.views);

    expect(sorted.map((row) => row.views)).toEqual(rows.map((row) => row.views).sort((a, b) => b - a));
    expect(sorted.map((row) => row.index)).not.toEqual(
      [...rows].sort((a, b) => b.views - a.views).map((row) => row.index),
    );
  });
});
