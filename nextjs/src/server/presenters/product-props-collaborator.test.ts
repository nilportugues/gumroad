import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], queries: [] as string[], foundUserIds: [] as unknown[] }));

vi.mock("../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models/sql.ts")>()),
  selectRows: async (query: { sql: string }) => {
    mocks.queries.push(query.sql);
    return mocks.rows;
  },
}));
vi.mock("./product-reads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./product-reads.ts")>()),
  findUserById: async (id: unknown) => {
    mocks.foundUserIds.push(id);
    return { id };
  },
}));

import { collaboratorForDisplay } from "./product-props.ts";

const product = { id: 7n } as never;
const APPLY_TO_ALL_PRODUCTS = 1;
const DONT_SHOW_AS_CO_CREATOR = 4;
const collaboration = (affiliateFlags: number, productAffiliateFlags: number) => ({
  affiliate_user_id: 42,
  affiliate_flags: affiliateFlags,
  product_affiliate_flags: productAffiliateFlags,
});

// Link#collaborator_for_display
describe("collaboratorForDisplay", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.queries = [];
    mocks.foundUserIds = [];
  });

  it("is null for a product without an accepted collaborator", async () => {
    expect(await collaboratorForDisplay(product)).toBeNull();
    expect(mocks.foundUserIds).toEqual([]);
  });

  it("reads only undeleted collaborators whose invitation was accepted", async () => {
    await collaboratorForDisplay(product);

    expect(mocks.queries[0]).toContain("`affiliates`.`type` = 'Collaborator'");
    expect(mocks.queries[0]).toContain("`affiliates`.`deleted_at` IS NULL");
    expect(mocks.queries[0]).toContain("`collaborator_invitations`.`id` IS NULL");
  });

  it("returns the collaborator's user", async () => {
    mocks.rows = [collaboration(0, 0)];

    expect(await collaboratorForDisplay(product)).toEqual({ id: 42 });
  });

  it("hides a collaborator that opted out of the co-creator credit for this product", async () => {
    mocks.rows = [collaboration(0, 1)];

    expect(await collaboratorForDisplay(product)).toBeNull();
  });

  it("follows the collaborator's own opt-out when it applies to all products", async () => {
    mocks.rows = [collaboration(APPLY_TO_ALL_PRODUCTS | DONT_SHOW_AS_CO_CREATOR, 0)];
    expect(await collaboratorForDisplay(product)).toBeNull();

    mocks.rows = [collaboration(APPLY_TO_ALL_PRODUCTS, 1)];
    expect(await collaboratorForDisplay(product)).toEqual({ id: 42 });
  });

  it("ignores the collaborator's opt-out flag when the collaboration is per product", async () => {
    mocks.rows = [collaboration(DONT_SHOW_AS_CO_CREATOR, 0)];

    expect(await collaboratorForDisplay(product)).toEqual({ id: 42 });
  });
});
