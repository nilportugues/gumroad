import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, selectRows, registerMutations, calls, performAsync, collaboratingProductIds, updateBang } = vi.hoisted(
  () => ({
    collaboratingProductIds: vi.fn(),
    updateBang: vi.fn(),
    execute: vi.fn(),
    selectRows: vi.fn(),
    registerMutations: vi.fn(),
    calls: [] as string[],
    performAsync: vi.fn(),
  }),
);

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  execute,
  selectRows,
}));
vi.mock("./mutation.ts", () => ({ registerMutations }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: () => ({ email: "seller@example.com" }) }));
vi.mock("../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../policies/seller-context.ts")>()),
  loadSellerContext: async () => ({}),
}));
vi.mock("../policies/link.ts", async (original) => ({
  ...(await original<typeof import("../policies/link.ts")>()),
  collaboratingProductIds,
}));
vi.mock("../policies/authorize.ts", () => ({ authorize: vi.fn() }));
vi.mock("../models/concerns/job-runtime.ts", () => ({ performAsync }));
vi.mock("../models/link.ts", async (original) => {
  const actual = await original<typeof import("../models/link.ts")>();
  return {
    ...actual,
    Links: { ...actual.Links, updateBang },
    LinkDeletable: { markDeletedBang: async () => void calls.push("mark link deleted") },
  };
});
vi.mock("../models/seller-profile-products-sections.ts", () => ({
  assertProfileSectionsEditable: async (...args: unknown[]) => void calls.push(`assert sections ${args.join(",")}`),
  clearFeaturedProductSections: async (...args: unknown[]) =>
    void calls.push(`clear featured ${args.slice(0, 2).join(",")}`),
  removeFromProfileSections: async (...args: unknown[]) =>
    void calls.push(`remove from sections ${args.slice(0, 2).join(",")}`),
}));
vi.mock("../models/custom-domain.ts", () => ({
  aliveCustomDomainOfProduct: async (id: unknown) => (
    calls.push(`find custom domain ${String(id)}`), { domain: "shop.example.com" }
  ),
  CustomDomainDeletable: {
    markDeletedBang: async (domain: { domain: string }) =>
      void calls.push(`mark custom domain deleted ${domain.domain}`),
  },
}));

const { schedulePublicFilesForDeletion } = await import("./products-mutations.ts");

beforeEach(() => {
  execute.mockReset();
  selectRows.mockReset();
  performAsync.mockReset();
  collaboratingProductIds.mockReset();
  updateBang.mockReset();
  calls.length = 0;
});

describe("schedulePublicFilesForDeletion", () => {
  it("schedules the live public files of the product ten minutes ahead (the column keeps fractions) without touching updated_at", async () => {
    await schedulePublicFilesForDeletion(42n, new Date("2025-03-01T10:00:00.789Z"));
    const sql = execute.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.sql).toBe(
      "UPDATE `public_files` SET `public_files`.`scheduled_for_deletion_at` = ? WHERE `public_files`.`resource_id` = ? AND `public_files`.`resource_type` = 'Link' AND `public_files`.`deleted_at` IS NULL",
    );
    expect(sql.values).toEqual([new Date("2025-03-01T10:10:00.789Z"), 42n]);
  });
});

describe("DELETE /links/:id", () => {
  const PRODUCT_ROW = { id: 42n, user_id: 7n, unique_permalink: "abc", flags: 0n, deleted_at: null };
  const handler = () =>
    registerMutations.mock.calls[0]!.find(
      (spec: { method: string; pattern: string }) => spec.method === "DELETE" && spec.pattern === "/links/:id",
    ) as { run: (input: unknown) => Promise<{ status: number; body: string }> };
  const input = {
    params: {},
    routeParams: { id: "abc" },
    context: { currentSeller: { id: 7n }, impersonatedUser: null },
  };

  it("removes the product from the seller's profile sections and deletes its custom domain, between marking it deleted and scheduling its files", async () => {
    // fetchVisibleProduct, then the active-subscription check
    selectRows.mockResolvedValueOnce([PRODUCT_ROW]).mockResolvedValueOnce([]);
    const result = await handler().run(input);

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(calls).toEqual([
      "assert sections 7,42",
      "mark link deleted",
      "clear featured 7,42",
      "remove from sections 7,42",
      "find custom domain 42",
      "mark custom domain deleted shop.example.com",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("POST /links/:id/unpublish", () => {
  const OTHER_SELLERS_PRODUCT = {
    id: 42n,
    user_id: 99n,
    unique_permalink: "abc",
    flags: 0n,
    deleted_at: null,
    purchase_disabled_at: null,
  };
  const handler = () =>
    registerMutations.mock.calls[0]!.find(
      (spec: { method: string; pattern: string }) => spec.method === "POST" && spec.pattern === "/links/:id/unpublish",
    ) as { run: (input: unknown) => Promise<{ status: number; body: string }> };
  const input = {
    params: {},
    routeParams: { id: "abc" },
    context: { currentSeller: { id: 7n }, impersonatedUser: null },
  };

  it("takes a collaborator's product off sale although another seller owns it", async () => {
    selectRows.mockResolvedValueOnce([OTHER_SELLERS_PRODUCT]);
    collaboratingProductIds.mockResolvedValueOnce(new Set([42n]));
    const result = await handler().run(input);

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(updateBang).toHaveBeenCalledTimes(1);
    expect(updateBang.mock.calls[0]![1]).toEqual({ purchase_disabled_at: expect.any(Date) });
  });

  it("answers 404 for another seller's product the user does not collaborate on", async () => {
    selectRows.mockResolvedValueOnce([OTHER_SELLERS_PRODUCT]);
    collaboratingProductIds.mockResolvedValueOnce(new Set());

    await expect(handler().run(input)).rejects.toThrow("Not Found");
    expect(updateBang).not.toHaveBeenCalled();
  });
});
