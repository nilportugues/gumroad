import { describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "links-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  fetchProductForShow: vi.fn(),
  selectRows: vi.fn(),
  railsLoggedInUser: vi.fn(),
}));
vi.mock("./product-page.ts", async (original) => ({
  ...(await original<object>()),
  fetchProductForShow: mocks.fetchProductForShow,
}));
vi.mock("./products-mutations.ts", () => ({ find: vi.fn() }));
vi.mock("../models/sql.ts", async (original) => ({ ...(await original<object>()), selectRows: mocks.selectRows }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: mocks.railsLoggedInUser }));
vi.mock("../infra/flipper.ts", () => ({
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
  userActor: (id: bigint) => `User;${id}`,
}));

const { card, landingVersion, search } = await import("./links-mutations.ts");
const { HandBackToRails, RoutingError } = await import("./application-controller.ts");

const input = (params: Record<string, unknown> = {}, routeParams: Record<string, string> = { id: "abc" }) =>
  ({ request: { host: "app.example.com" }, context: {}, params, routeParams }) as never;
const body = (result: unknown) => JSON.parse(String((result as { body: string }).body)) as unknown;

describe("LinksController#landing_version", () => {
  const shown = (overrides: Record<string, unknown> = {}) => ({
    product: { id: 5n, user_id: 9n, banned_at: null, deleted_at: null, purchase_disabled_at: null },
    seller: { deleted_at: null },
    isUserCustomDomain: false,
    domainSeller: null,
    ...overrides,
  });

  it("tells a visitor that the landing page is absent", async () => {
    mocks.fetchProductForShow.mockResolvedValue(shown());
    mocks.railsLoggedInUser.mockReturnValue(null);

    expect(body(await landingVersion(input()))).toEqual({ present: false, version: null });
  });

  it("gives the owner the version of the root page in epoch seconds", async () => {
    mocks.fetchProductForShow.mockResolvedValue(shown());
    mocks.railsLoggedInUser.mockReturnValue({ id: 9n, flags: 0n });
    mocks.selectRows.mockResolvedValue([{ custom_html: "<p>x</p>", updated_at: new Date("2025-01-02T00:00:00Z") }]);

    expect(body(await landingVersion(input()))).toEqual({ present: true, version: 1735776000 });
  });

  it("reports a page with blank HTML as absent", async () => {
    mocks.fetchProductForShow.mockResolvedValue(shown());
    mocks.railsLoggedInUser.mockReturnValue({ id: 9n, flags: 0n });
    mocks.selectRows.mockResolvedValue([{ custom_html: " \n", updated_at: new Date() }]);

    expect(body(await landingVersion(input()))).toEqual({ present: false, version: null });
  });

  it("answers not found for a banned product", async () => {
    mocks.fetchProductForShow.mockResolvedValue(shown({ product: { id: 5n, user_id: 9n, banned_at: new Date() } }));

    await expect(landingVersion(input())).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers not found for the product of a deleted seller", async () => {
    mocks.fetchProductForShow.mockResolvedValue(shown({ seller: { deleted_at: new Date() } }));

    await expect(landingVersion(input())).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("LinksController#search", () => {
  it("answers an empty page for a seller that does not exist", async () => {
    mocks.selectRows.mockResolvedValue([]);

    expect(body(await search(input({ user_id: "nobody" })))).toEqual({
      total: 0,
      filetypes_data: [],
      tags_data: [],
      taxonomy_attributes_data: [],
      products: [],
    });
  });

  it("answers an empty page for a section the seller does not have", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValueOnce([{ id: 1n }]).mockResolvedValueOnce([]);

    expect(body(await search(input({ user_id: "seller", section_id: "nope" })))).toMatchObject({
      total: 0,
      products: [],
    });
  });

  it.each([{}, { user_id: "" }, { user_id: ["a"] }, { user_id: "x", ids: "a,b" }])(
    "hands %j to Rails",
    async (params) => {
      await expect(search(input(params))).rejects.toBeInstanceOf(HandBackToRails);
    },
  );

  it("hands the virtual default products section to Rails", async () => {
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue([{ id: 1n }]);

    await expect(search(input({ user_id: "seller", section_id: "default-products" }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});

describe("LinksController#card", () => {
  it("answers not found because the controller has no such action", async () => {
    await expect(card()).rejects.toBeInstanceOf(RoutingError);
  });
});
