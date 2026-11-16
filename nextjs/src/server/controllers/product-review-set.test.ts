import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RestrictedOperationError } from "../models/product-review.ts";
import { RecordInvalid, Errors } from "../models/runtime/errors.ts";

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
  existing: vi.fn(),
  post: vi.fn(),
  allows: vi.fn(),
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
vi.mock("../models/product-review.ts", () => ({
  findReviewOfPurchase: mocks.existing,
  postReview: mocks.post,
  RestrictedOperationError: class RestrictedOperationError extends Error {},
}));
vi.mock("../models/purchase.ts", () => ({ allowsReview: mocks.allows }));
vi.mock("../page-props/buyer/reviews.ts", () => ({ emailDigest: mocks.digest }));

await import("./product-review-set.ts");

const set = mocks.specs[0]!.run;
const PURCHASE = { id: 7n, purchaser_id: null, subscription_id: null, flags: 0n };
const POSTED = { anonymous: false, rating: 5, message: "Worth it", video: null };
const NOW = new Date("2026-06-01T00:00:00Z");

const call = (params: Record<string, unknown>) => set({ params } as unknown as MutationInput);
const valid = { link_id: "permalink", purchase_id: "p", purchase_email_digest: "digest" };
const message = (text: string) => ({ status: 200, body: { success: false, message: text } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: NOW });
  mocks.selectRows.mockResolvedValue([{ id: 1n, user_id: 2n }]);
  mocks.purchase.mockResolvedValue({ ...PURCHASE, created_at: new Date("2026-05-01T00:00:00Z") });
  mocks.existing.mockResolvedValue(null);
  mocks.allows.mockReturnValue(true);
  mocks.post.mockResolvedValue(POSTED);
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
    mocks.purchase.mockResolvedValue({ ...PURCHASE, purchaser_id: 9n, created_at: NOW });
    mocks.suspended.mockReturnValue(true);
    expect(await call(valid)).toEqual(message("Sorry, you are not authorized to review this product."));
  });

  it("refuses a purchase older than a year when the seller closed reviews after one", async () => {
    mocks.purchase.mockResolvedValue({ ...PURCHASE, created_at: new Date("2025-01-01T00:00:00Z") });
    mocks.flag.mockReturnValue(true);
    expect(await call(valid)).toEqual(message("Sorry, something went wrong."));
  });

  it("posts the review of an old purchase when the seller left reviews open", async () => {
    mocks.purchase.mockResolvedValue({ ...PURCHASE, created_at: new Date("2025-01-01T00:00:00Z") });
    mocks.flag.mockReturnValue(false);
    expect(await call({ ...valid, rating: 5 })).toEqual({ status: 200, body: { success: true, review: POSTED } });
  });

  describe("posting the review", () => {
    const post = (extra: Record<string, unknown> = {}) => call({ ...valid, rating: 4, message: "Fine", ...extra });

    it("answers the saved review and leaves the identity alone when the request omits it", async () => {
      expect(await post()).toEqual({ status: 200, body: { success: true, review: POSTED } });
      expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ id: 7n }), 1n, {
        rating: 4,
        message: "Fine",
        anonymous: "unchanged",
      });
    });

    it.each([
      [true, true],
      ["true", true],
      ["1", true],
      ["on", true],
      [false, false],
      ["false", false],
      ["0", false],
      ["off", false],
      ["F", false],
      [0, false],
      [null, false],
      ["", false],
    ])("casts the identity choice %j to %j", async (sent, cast) => {
      await post({ anonymous: sent });
      expect(mocks.post.mock.calls[0]![2]).toMatchObject({ anonymous: cast });
    });

    it("reads a numeric string as the rating the way to_i does and a missing one as zero", async () => {
      await post({ rating: " 3 stars" });
      expect(mocks.post.mock.calls[0]![2]).toMatchObject({ rating: 3 });
      await call(valid);
      expect(mocks.post.mock.calls[1]![2]).toMatchObject({ rating: 0, message: null });
    });

    it.each([
      ["a fractional rating", { rating: 4.5 }],
      ["a rating that is not a number", { rating: "five" }],
      ["a structured message", { message: ["a"] }],
      ["a structured identity choice", { anonymous: { a: 1 } }],
      ["video options", { video_options: { destroy: { id: "x" } } }],
    ])("hands %s back to Rails before any write", async (_name, extra) => {
      await expect(post(extra)).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.post).not.toHaveBeenCalled();
    });

    it("posts empty video options like none", async () => {
      await post({ video_options: {} });
      expect(mocks.post).toHaveBeenCalled();
    });

    it.each([
      ["a subscription purchase", { subscription_id: 3n }],
      ["a gift sender purchase", { flags: 64n }],
    ])("hands %s back to Rails", async (_name, attributes) => {
      mocks.purchase.mockResolvedValue({ ...PURCHASE, created_at: NOW, ...attributes });
      mocks.flag.mockReturnValue(false);
      await expect(post()).rejects.toBeInstanceOf(HandBackToRails);
    });

    it("hands a review that carries a video back to Rails", async () => {
      mocks.existing.mockResolvedValue({ get: () => 5 });
      mocks.selectRows.mockResolvedValueOnce([{ id: 1n, user_id: 2n }]).mockResolvedValueOnce([{ present: 1 }]);
      await expect(post()).rejects.toBeInstanceOf(HandBackToRails);
      expect(mocks.post).not.toHaveBeenCalled();
    });

    describe("when the purchase no longer allows a review", () => {
      const existing = (rating: number, text: string | null) => ({
        get: (name: string) => (name === "rating" ? rating : text),
      });
      beforeEach(() => {
        mocks.allows.mockReturnValue(false);
        mocks.selectRows.mockResolvedValueOnce([{ id: 1n, user_id: 2n }]).mockResolvedValue([]);
      });

      it("refuses a first review", async () => {
        expect(await post()).toEqual(message("This purchase is no longer eligible for a review."));
        expect(mocks.post).not.toHaveBeenCalled();
      });

      it("refuses a changed rating of an existing review", async () => {
        mocks.existing.mockResolvedValue(existing(5, "Fine"));
        expect(await post()).toEqual(
          message("You can no longer change this review, but you can still show it as Anonymous."),
        );
      });

      it("refuses a changed message of an existing review", async () => {
        mocks.existing.mockResolvedValue(existing(4, "Other"));
        expect(await post()).toEqual(
          message("You can no longer change this review, but you can still show it as Anonymous."),
        );
      });

      it("lets the identity move when the rating and message stay", async () => {
        mocks.existing.mockResolvedValue(existing(4, "Fine"));
        expect(await post({ anonymous: true })).toEqual({ status: 200, body: { success: true, review: POSTED } });
      });

      it("reads a missing message as the empty one of a review without text", async () => {
        mocks.existing.mockResolvedValue(existing(4, null));
        expect(await post({ message: undefined })).toEqual({ status: 200, body: { success: true, review: POSTED } });
      });
    });

    it("answers the validation message of a record that is not valid", async () => {
      const errors = new Errors();
      errors.add("rating", "Invalid product rating.");
      mocks.post.mockRejectedValue(new RecordInvalid(errors));
      expect(await post({ rating: 9 })).toEqual(message("Validation failed: Rating Invalid product rating."));
    });

    it("answers something went wrong when the model refuses the operation", async () => {
      mocks.post.mockRejectedValue(new RestrictedOperationError("no"));
      expect(await post()).toEqual(message("Sorry, something went wrong."));
    });

    it("lets an unexpected failure through", async () => {
      mocks.post.mockRejectedValue(new Error("connection lost"));
      await expect(post()).rejects.toThrow("connection lost");
    });
  });
});
