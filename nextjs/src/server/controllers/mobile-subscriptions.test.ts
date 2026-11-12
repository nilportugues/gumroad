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
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
  encrypt: (value: number | bigint) => `enc${value}`,
}));
vi.mock("../page-props/signed-in/presenters.ts", () => ({ avatarUrl: async () => "https://example.com/avatar.png" }));
vi.mock("../page-props/buyer/users.ts", () => ({ profileUrl: () => "https://seller.example.com" }));
vi.mock("../presenters/mobile-preview.ts", () => ({ mobilePreview }));
vi.mock("../presenters/mobile-serializer-reads.ts", () => ({ thumbnailUrlsByProduct: async () => new Map() }));

await import("./mobile-subscriptions.ts");

const action = actions.find((candidate) => candidate.method === "GET")!;
const input = (params: Record<string, unknown> = {}) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;

const subscription = {
  id: 4n,
  link_id: 2n,
  created_at: new Date("2026-11-02T15:00:00.123Z"),
  charge_occurrence_count: null as number | null,
  last_payment_option_id: 8n,
};
const link = {
  id: 2n,
  user_id: 7n,
  name: "Membership",
  unique_permalink: "mem",
  description: "d",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-02T00:00:00Z"),
  content_updated_at: null,
  flags: 0,
};
const creator = { id: 7n, name: "Seller", username: "seller" };
const purchase = (extra = {}) => ({
  id: 11n,
  price_id: null,
  purchaser_id: 5n,
  created_at: new Date("2026-11-02T15:00:00Z"),
  displayed_price_cents: 500,
  displayed_price_currency_type: "usd",
  can_contact: true,
  ...extra,
});

// The queries in order: active subscription, original purchase id, then (per test) posts, payment option, price.
function stub({
  posts = false,
  previews = false,
  recurrence = "monthly" as string | null,
  sub = subscription,
  row = purchase(),
} = {}) {
  selectRows.mockReset();
  selectRows
    .mockResolvedValueOnce([sub])
    .mockResolvedValueOnce([{ id: row.id }])
    .mockResolvedValueOnce(posts ? [{}] : [])
    .mockResolvedValueOnce([{ price_id: 3n }])
    .mockResolvedValueOnce([{ recurrence }]);
  mobilePreview.mockReset();
  if (previews) mobilePreview.mockRejectedValue(new NotPortedError("Link#as_json(mobile: true) for an uploaded cover"));
  else mobilePreview.mockResolvedValue({ preview: null, thumbnailOrCoverUrl: null });
  db.link.findUnique.mockResolvedValue(link);
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: bigint } }) =>
    where.id === 7n ? creator : { id: 5n, external_id: "buyer-ext" },
  );
  db.purchase.findUnique.mockResolvedValue(row);
}

beforeEach(() => {
  selectRows.mockReset();
  Object.values(db).forEach((model) => Object.values(model).forEach((fn) => fn.mockReset()));
});

describe("GET /mobile/subscriptions/subscription_attributes/:id", () => {
  it("registers the read without an OAuth scope and the cancel under mobile_api", () => {
    expect(actions.map((a) => [a.method, a.pattern, a.scopes])).toEqual([
      ["POST", "/mobile/subscriptions/:id/cancel", ["mobile_api"]],
      ["GET", "/mobile/subscriptions/subscription_attributes/:id", null],
    ]);
  });

  // spec/controllers/api/mobile/subscriptions_controller_spec.rb "returns an error response for a dead subscription"
  it("answers 404 when the subscription is not active", async () => {
    selectRows.mockResolvedValue([]);
    const result = await action.run(input({ id: "4" }), null);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find subscription" });
  });

  it("answers 404 for an id that decrypts to nothing without querying", async () => {
    expect(status(await action.run(input({ id: "xxx" }), null))).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("serializes a live monthly subscription", async () => {
    stub();
    const json = body(await action.run(input({ id: "4" }), null));
    expect(json.success).toBe(true);
    expect(json.subscription).toMatchObject({
      name: "Membership",
      subscription_data: { subscribed_at: "2026-11-02T15:00:00Z", external_id: "enc4", recurring_amount: "$5 a month" },
      purchase_id: "enc11",
      purchased_at: "2026-11-02T15:00:00Z",
      user_id: "buyer-ext",
      can_contact: true,
      updates_data: [],
    });
    expect(Object.keys(json.subscription).slice(-6)).toEqual([
      "subscription_data",
      "purchase_id",
      "purchased_at",
      "user_id",
      "can_contact",
      "updates_data",
    ]);
  });

  it("labels a one-charge subscription once and a price without recurrence plainly", async () => {
    stub({ sub: { ...subscription, charge_occurrence_count: 1 } });
    expect(body(await action.run(input({ id: "4" }), null)).subscription.subscription_data.recurring_amount).toBe(
      "$5 once",
    );
    stub({ recurrence: null, sub: { ...subscription, charge_occurrence_count: 1 } });
    expect(body(await action.run(input({ id: "4" }), null)).subscription.subscription_data.recurring_amount).toBe(
      "$5 x 1",
    );
  });

  it("hands back a seller with posts, a product with previews and a non-USD purchase", async () => {
    stub({ posts: true });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/seller with posts/u);
    stub({ previews: true });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/uploaded cover/u);
    stub({ row: purchase({ displayed_price_currency_type: "eur" }) });
    await expect(action.run(input({ id: "4" }), null)).rejects.toThrow(/currency other than USD/u);
  });
});
