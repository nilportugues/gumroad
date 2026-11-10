import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotPortedError } from "../models/user.ts";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, findResponseOfReview, destroyBang } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  findResponseOfReview: vi.fn(),
  destroyBang: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../models/product-review-response.ts", () => ({
  findResponseOfReview,
  ProductReviewResponses: { destroyBang },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./mobile-review-responses.ts");

const GIFT_SENDER_FLAG = 64n;
const action = actions.find((registered) => registered.method === "DELETE")!;
const auth = { owner: { id: 7n } } as unknown as MobileAuth;
const input = (id: unknown) => ({ params: { id } }) as unknown as MobileInput;
const body = (result: unknown) =>
  JSON.parse((result as { body: string }).body) as { success: boolean; message?: string };
const status = (result: unknown) => (result as { status: number }).status;
const sale = (attributes: Record<string, unknown> = {}) => ({
  id: 11n,
  subscription_id: null,
  flags: 0n,
  ...attributes,
});

beforeEach(() => {
  selectRows.mockReset();
  findResponseOfReview.mockReset();
  destroyBang.mockReset();
});

describe("DELETE /mobile/sales/:id/review_response", () => {
  it("registers behind the mobile_api scope", () => {
    expect(action.pattern).toBe("/mobile/sales/:id/review_response");
    expect(action.scopes).toEqual(["mobile_api"]);
  });

  it("answers 404 for an id that does not decrypt, without reading the database", async () => {
    const result = await action.run(input("not-an-id"), auth);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await action.run(input("11"), auth);
    expect(status(result)).toBe(404);
    expect(body(result).message).toBe("Could not find purchase");
  });

  it("answers 404 when the sale has no review", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([]);
    const result = await action.run(input("11"), auth);
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find review response" });
    expect(destroyBang).not.toHaveBeenCalled();
  });

  it("answers 404 when the review has no reply", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ id: 5n }]);
    findResponseOfReview.mockResolvedValue(null);
    const result = await action.run(input("11"), auth);
    expect(status(result)).toBe(404);
    expect(body(result).message).toBe("Could not find review response");
    expect(findResponseOfReview).toHaveBeenCalledWith(5n);
  });

  it("destroys the reply and answers success", async () => {
    const reply = { id: 9n };
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ id: 5n }]);
    findResponseOfReview.mockResolvedValue(reply);
    const result = await action.run(input("11"), auth);
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: true });
    expect(destroyBang).toHaveBeenCalledWith(reply);
  });

  it("hands a subscription sale back to Rails before reading any review", async () => {
    selectRows.mockResolvedValueOnce([sale({ subscription_id: 3n })]);
    await expect(action.run(input("11"), auth)).rejects.toBeInstanceOf(NotPortedError);
    expect(selectRows).toHaveBeenCalledTimes(1);
    expect(destroyBang).not.toHaveBeenCalled();
  });

  it("hands a gift sender's sale back to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale({ flags: GIFT_SENDER_FLAG })]);
    await expect(action.run(input("11"), auth)).rejects.toBeInstanceOf(NotPortedError);
    expect(destroyBang).not.toHaveBeenCalled();
  });
});
