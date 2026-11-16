import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows, collaboratingProductIds, railsLoggedInUser } = vi.hoisted(() => ({
  selectRows: vi.fn(),
  collaboratingProductIds: vi.fn(),
  railsLoggedInUser: vi.fn(),
}));

vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser }));
vi.mock("../policies/link.ts", async (original) => ({
  ...(await original<typeof import("../policies/link.ts")>()),
  collaboratingProductIds,
}));
vi.mock("../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../policies/seller-context.ts")>()),
  loadSellerContext: async () => ({}),
}));
vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));
// The chain around the action (session, CSRF, locale) is not under test: run the action on a fixed input.
vi.mock("./json-actions.ts", async (original) => ({
  ...(await original<typeof import("./json-actions.ts")>()),
  jsonAction: async (
    _request: Request,
    routeParams: Record<string, string>,
    _options: unknown,
    run: (input: unknown) => Promise<{ status: number; body: string }>,
  ) => {
    const result = await run({ params: {}, routeParams, context: { currentSeller: { id: 7n } } });
    return new Response(result.body, { status: result.status });
  },
}));

import { internalResponse } from "./internal-api.ts";

const get = (permalink: string) =>
  internalResponse(
    new Request("http://example.com/gr-public/internal", {
      headers: { "x-gr-page-url": `/internal/products/${permalink}/existing_product_files` },
    }),
  );

const OWN_PRODUCT = { id: 42n, user_id: 7n };
const OTHER_SELLERS_PRODUCT = { id: 43n, user_id: 99n };

beforeEach(() => {
  selectRows.mockReset();
  collaboratingProductIds.mockReset();
  railsLoggedInUser.mockReset();
  railsLoggedInUser.mockReturnValue({ id: 5n });
});

describe("GET /internal/products/:product_id/existing_product_files", () => {
  it("lists nothing for the owner of a product whose library has no files", async () => {
    selectRows.mockResolvedValueOnce([OWN_PRODUCT]).mockResolvedValueOnce([]);
    const response = await get("own");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ existing_files: [] });
    expect(collaboratingProductIds).not.toHaveBeenCalled();
  });

  it("lists nothing for a collaborator on another seller's product whose library has no files", async () => {
    selectRows.mockResolvedValueOnce([OTHER_SELLERS_PRODUCT]).mockResolvedValueOnce([]);
    collaboratingProductIds.mockResolvedValueOnce(new Set([43n]));
    const response = await get("theirs");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ existing_files: [] });
    expect(collaboratingProductIds).toHaveBeenCalledWith(expect.anything(), [43n]);
  });

  it("answers 404 for another seller's product the user does not collaborate on", async () => {
    selectRows.mockResolvedValueOnce([OTHER_SELLERS_PRODUCT]);
    collaboratingProductIds.mockResolvedValueOnce(new Set());

    await expect(get("theirs")).rejects.toThrow("Not Found");
    expect(selectRows).toHaveBeenCalledTimes(1);
  });
});
