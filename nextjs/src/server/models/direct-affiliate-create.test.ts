import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn() }));

vi.mock("./sql.ts", () => ({ selectRows: mocks.selectRows, column: () => "", table: () => "" }));
vi.mock("../mail/active-job.ts", () => ({ deliverLater: vi.fn() }));
vi.mock("../mail/delivery.ts", () => ({ mailRoute: () => "ruby" }));

const { creationBlocker, rubyToI } = await import("./direct-affiliate-create.ts");

const golden = JSON.parse(readFileSync(new URL("../../../parity/golden/ruby-to-i.json", import.meta.url), "utf8")) as {
  strings: Record<string, number>;
  numbers: Record<string, number>;
};

describe("rubyToI", () => {
  it.each(Object.entries(golden.strings))("reads the string %j as Ruby's String#to_i does", (input, expected) => {
    expect(rubyToI(input)).toBe(expected);
  });

  it.each(Object.entries(golden.numbers))("truncates the number %s as Ruby's Float#to_i does", (input, expected) => {
    expect(rubyToI(Number(input))).toBe(expected);
  });

  it("reads null as 0", () => {
    expect(rubyToI(null)).toBe(0);
  });
});

const requested = { applyToAllProducts: false, enabledProducts: [{ destinationUrl: null }], destinationUrl: null };
const affiliate = {
  sellerId: 3,
  affiliateUserId: 9,
  affiliateUserEmail: "ada@example.com",
  basisPoints: 1000,
  productId: 11,
};

// creationBlocker reads, in order: the product, a Brazilian merchant account, a live affiliation of the account.
const reads = (rows: { product?: unknown[]; brazilian?: unknown[]; existing?: unknown[] } = {}) =>
  mocks.selectRows
    .mockResolvedValueOnce(rows.product ?? [{ flags: 0n, deleted_at: null }])
    .mockResolvedValueOnce(rows.brazilian ?? [])
    .mockResolvedValueOnce(rows.existing ?? []);

beforeEach(() => mocks.selectRows.mockReset());

describe("creationBlocker", () => {
  it("accepts one plain product", async () => {
    reads();
    expect(await creationBlocker(requested, affiliate)).toBeNull();
  });

  it.each([
    ["all products", { ...requested, applyToAllProducts: true }],
    ["two products", { ...requested, enabledProducts: [{ destinationUrl: null }, { destinationUrl: null }] }],
    ["a destination url", { ...requested, destinationUrl: "https://example.com" }],
    ["an empty destination url, which Rails stores as sent", { ...requested, destinationUrl: "" }],
    ["a product destination url", { ...requested, enabledProducts: [{ destinationUrl: "https://example.com" }] }],
  ])("hands back %s before reading anything", async (_name, shape) => {
    expect(await creationBlocker(shape, affiliate)).not.toBeNull();
    expect(mocks.selectRows).not.toHaveBeenCalled();
  });

  it.each([99, 7501, 0])("hands back a fee of %i basis points", async (basisPoints) => {
    expect(await creationBlocker(requested, { ...affiliate, basisPoints })).not.toBeNull();
  });

  it.each([100, 7500])("accepts a fee of %i basis points", async (basisPoints) => {
    reads();
    expect(await creationBlocker(requested, { ...affiliate, basisPoints })).toBeNull();
  });

  it("hands back an account whose email is not an audience member's", async () => {
    expect(await creationBlocker(requested, { ...affiliate, affiliateUserEmail: "not an email" })).not.toBeNull();
  });

  it("hands back a product the seller does not have", async () => {
    reads({ product: [] });
    expect(await creationBlocker(requested, affiliate)).toMatch(/does not have/u);
  });

  it("hands back a deleted product", async () => {
    reads({ product: [{ flags: 0n, deleted_at: new Date() }] });
    expect(await creationBlocker(requested, affiliate)).toMatch(/deleted/u);
  });

  it("hands back a collab product", async () => {
    reads({ product: [{ flags: 1n << 27n, deleted_at: null }] });
    expect(await creationBlocker(requested, affiliate)).toMatch(/collab/u);
  });

  it("hands back a Brazilian merchant account", async () => {
    reads({ brazilian: [{ id: 1 }] });
    expect(await creationBlocker(requested, affiliate)).toMatch(/Brazilian/u);
  });

  it("hands back an account the seller already has as an affiliate", async () => {
    reads({ existing: [{ id: 1 }] });
    expect(await creationBlocker(requested, affiliate)).toMatch(/already has/u);
  });
});
