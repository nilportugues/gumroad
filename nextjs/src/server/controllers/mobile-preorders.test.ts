import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import type { MobileAction, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, db, mobilePreview } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  mobilePreview: vi.fn(),
  db: { link: { findUnique: vi.fn() }, user: { findUnique: vi.fn() }, purchase: { findUnique: vi.fn() } },
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../lib/db.ts", () => ({ db }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? BigInt(value) : null),
  encrypt: (value: number | bigint) => `enc${value}`,
}));
vi.mock("../page-props/signed-in/presenters.ts", () => ({ avatarUrl: async () => "https://example.com/avatar.png" }));
vi.mock("../page-props/buyer/users.ts", () => ({ profileUrl: () => "https://seller.example.com" }));
vi.mock("../presenters/mobile-preview.ts", () => ({ mobilePreview }));
vi.mock("../presenters/mobile-serializer-reads.ts", () => ({ thumbnailUrlsByProduct: async () => new Map() }));

await import("./mobile-preorders.ts");

const action = actions[0]!;
const input = (params: Record<string, unknown> = {}) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;

// flag_shih_tzu: flag 17 is bit 2**16
const IS_ARCHIVED_FLAG = 2 ** 16;
const preorder = { id: 4n, state: "authorization_successful", preorder_link_id: 6n };
const link = {
  id: 2n,
  user_id: 7n,
  name: "Upcoming album",
  unique_permalink: "album",
  description: "d",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-02T00:00:00Z"),
  content_updated_at: null,
  flags: 0,
};
const creator = { id: 7n, name: "Seller", username: "seller" };
const purchase = (extra = {}) => ({
  id: 11n,
  purchaser_id: 5n,
  created_at: new Date("2026-11-02T15:00:00Z"),
  flags: 0,
  ...extra,
});

// The queries in order: the preorder, its purchases, its preorder link, then posts.
function stub({
  row = preorder,
  states = ["preorder_authorization_successful"] as (string | null)[],
  posts = false,
  previews = false,
  buyer = purchase(),
} = {}) {
  selectRows.mockReset();
  selectRows
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce(states.map((purchase_state, index) => ({ id: BigInt(11 + index), purchase_state })))
    .mockResolvedValueOnce([{ link_id: 2n, release_at: new Date("2026-12-01T10:00:00Z") }])
    .mockResolvedValueOnce(posts ? [{}] : []);
  mobilePreview.mockReset();
  if (previews) mobilePreview.mockRejectedValue(new NotPortedError("Link#as_json(mobile: true) for an uploaded cover"));
  else mobilePreview.mockResolvedValue({ preview: null, thumbnailOrCoverUrl: null });
  db.link.findUnique.mockResolvedValue(link);
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: bigint } }) =>
    where.id === 7n ? creator : { id: 5n, external_id: "buyer-ext" },
  );
  db.purchase.findUnique.mockResolvedValue(buyer);
}

beforeEach(() => {
  selectRows.mockReset();
  Object.values(db).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
});

describe("GET /mobile/preorders/preorder_attributes/:id", () => {
  it("registers without an OAuth scope", () => {
    expect(actions.map((a) => [a.method, a.pattern, a.scopes])).toEqual([
      ["GET", "/mobile/preorders/preorder_attributes/:id", null],
    ]);
  });

  it("answers 404 when the preorder is not authorization or charge successful", async () => {
    selectRows.mockResolvedValue([]);
    const result = await action.run(input({ id: "4" }), null);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find preorder" });
  });

  it("answers 404 for an id that decrypts to nothing without querying", async () => {
    expect(status(await action.run(input({ id: "xxx" }), null))).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("serializes the authorization purchase of an authorized preorder with its release date", async () => {
    stub();
    const json = body(await action.run(input({ id: "4" }), null));
    expect(json.success).toBe(true);
    expect(json.product).toMatchObject({
      name: "Upcoming album",
      purchase_id: "enc11",
      purchased_at: "2026-11-02T15:00:00Z",
      user_id: "buyer-ext",
      product_updates_data: [],
      is_archived: false,
      preorder_data: { external_id: "enc4", release_at: "2026-12-01T10:00:00Z" },
    });
    expect(Object.keys(json.product).slice(-6)).toEqual([
      "purchase_id",
      "purchased_at",
      "user_id",
      "product_updates_data",
      "is_archived",
      "preorder_data",
    ]);
  });

  it("omits user_id for a guest purchase", async () => {
    stub({ buyer: purchase({ purchaser_id: null }) });
    expect(body(await action.run(input({ id: "4" }), null)).product).not.toHaveProperty("user_id");
  });

  it("hands a charged preorder and one whose last purchase succeeded to Rails", async () => {
    stub({ row: { ...preorder, state: "charge_successful" } });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/charged preorder/u);
    stub({ states: ["preorder_authorization_successful", "successful"] });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/last purchase is successful/u);
  });

  it("hands back a seller with posts and a product with previews", async () => {
    stub({ posts: true });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/seller with posts/u);
    stub({ previews: true });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/uploaded cover/u);
  });

  it("reads the archived flag of the authorization purchase", async () => {
    stub({ buyer: purchase({ flags: IS_ARCHIVED_FLAG }) });
    expect(body(await action.run(input({ id: "4" }), null)).product.is_archived).toBe(true);
  });
});
