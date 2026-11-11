import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const mocks = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  selectRows: vi.fn(),
  purchase: vi.fn(),
  user: vi.fn(),
  digest: vi.fn(),
  suspended: vi.fn(),
  flag: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void mocks.specs.push(...registered),
}));
vi.mock("./seller-json.ts", () => ({ json: (body: unknown) => ({ status: 200, body }) }));
vi.mock("../../lib/db.ts", () => ({
  db: { purchase: { findFirst: mocks.purchase }, user: { findFirst: mocks.user } },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({ decrypt: (id: string) => (id === "unknown" ? null : 7) }));
vi.mock("../models/sql.ts", () => ({ selectRows: mocks.selectRows, column: () => "", table: () => "" }));
vi.mock("../models/user.ts", () => ({
  isSuspended: mocks.suspended,
  Users: { load: (row: unknown) => row },
  UserFlags: { isSet: mocks.flag },
}));
vi.mock("../page-props/buyer/reviews.ts", () => ({ emailDigest: mocks.digest }));

await import("./product-review-set.ts");

const set = mocks.specs[0]!.run;
const NOW = new Date("2026-06-01T00:00:00Z");

const call = (params: Record<string, unknown>) => set({ params } as unknown as MutationInput);
const valid = { link_id: "permalink", purchase_id: "p", purchase_email_digest: "digest" };
const message = (text: string) => ({ status: 200, body: { success: false, message: text } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: NOW });
  mocks.selectRows.mockResolvedValue([{ id: 1n, user_id: 2n }]);
  mocks.purchase.mockResolvedValue({ id: 7n, purchaser_id: null, created_at: new Date("2026-05-01T00:00:00Z") });
  mocks.user.mockResolvedValue({ id: 2n, flags: 0n });
  mocks.digest.mockReturnValue("digest");
});

afterEach(() => vi.useRealTimers());

describe("ProductReviewsController#set", () => {
  it("registers the PUT route", () => {
    expect(mocks.specs[0]).toMatchObject({ method: "PUT", pattern: "/product_reviews/set", json: true });
  });

  it("answers that the seller removed the product, before the after actions", async () => {
    mocks.selectRows.mockResolvedValue([]);
    expect(await call(valid)).toMatchObject({
      ...message("Sorry, this product was removed by the seller."),
      rescued: true,
    });
  });

  it("hands a permalink that is not text back to Rails", async () => {
    await expect(call({ ...valid, link_id: 5 })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a purchase id that is not text back to Rails", async () => {
    await expect(call({ ...valid, purchase_id: 5 })).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("answers something went wrong for a purchase id that does not decrypt", async () => {
    expect(await call({ ...valid, purchase_id: "unknown" })).toEqual(message("Sorry, something went wrong."));
  });

  it("answers something went wrong for a purchase of another product", async () => {
    mocks.purchase.mockResolvedValue(null);
    expect(await call(valid)).toEqual(message("Sorry, something went wrong."));
  });

  it("hands a purchase without an email digest back to Rails", async () => {
    mocks.digest.mockReturnValue(null);
    await expect(call(valid)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("refuses a wrong digest", async () => {
    expect(await call({ ...valid, purchase_email_digest: "other" })).toEqual(
      message("Sorry, you are not authorized to review this product."),
    );
  });

  it("reads a missing digest as an empty one", async () => {
    expect(await call({ link_id: "permalink", purchase_id: "p" })).toEqual(
      message("Sorry, you are not authorized to review this product."),
    );
  });

  it("refuses a suspended purchaser", async () => {
    mocks.purchase.mockResolvedValue({ id: 7n, purchaser_id: 9n, created_at: NOW });
    mocks.suspended.mockReturnValue(true);
    expect(await call(valid)).toEqual(message("Sorry, you are not authorized to review this product."));
  });

  it("refuses a purchase older than a year when the seller closed reviews after one", async () => {
    mocks.purchase.mockResolvedValue({ id: 7n, purchaser_id: null, created_at: new Date("2025-01-01T00:00:00Z") });
    mocks.flag.mockReturnValue(true);
    expect(await call(valid)).toEqual(message("Sorry, something went wrong."));
  });

  it("hands an old purchase back to Rails when the seller left reviews open", async () => {
    mocks.purchase.mockResolvedValue({ id: 7n, purchaser_id: null, created_at: new Date("2025-01-01T00:00:00Z") });
    mocks.flag.mockReturnValue(false);
    await expect(call(valid)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands a review from an eligible purchase back to Rails", async () => {
    await expect(call(valid)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
