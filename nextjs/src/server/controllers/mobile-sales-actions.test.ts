import { beforeEach, describe, expect, it, vi } from "vitest";

import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails } from "./application-controller.ts";
import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const {
  actions,
  selectRows,
  eligibleToSendEmails,
  resendReceipt,
  setPurchase,
  changeCanContact,
  performAsync,
  findResponseOfReview,
  createResponse,
  updateResponse,
  missedPostsOf,
} = vi.hoisted(() => ({
  missedPostsOf: vi.fn(),
  performAsync: vi.fn(),
  findResponseOfReview: vi.fn(),
  createResponse: vi.fn(),
  updateResponse: vi.fn(),
  changeCanContact: vi.fn(),
  resendReceipt: vi.fn(),
  setPurchase: vi.fn(),
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  eligibleToSendEmails: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../page-props/customers/customer-details.ts", () => ({ missedPosts: missedPostsOf }));
vi.mock("./purchase-resend-receipt.ts", () => ({ resendReceipt }));
vi.mock("../models/concerns/job-runtime.ts", () => ({ performAsync }));
vi.mock("../models/product-review-response.ts", () => ({
  findResponseOfReview,
  ProductReviewResponses: { create: createResponse, update: updateResponse },
}));
vi.mock("../models/purchase-contact-writes.ts", () => ({ changeCanContact }));
vi.mock("./purchase-access-writes.ts", () => ({ setPurchase }));
vi.mock("../models/user-email-eligibility.ts", () => ({ eligibleToSendEmails }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./mobile-sales-actions.ts");

const find = (method: string, pattern: string) =>
  actions.find((registered) => registered.method === method && registered.pattern === pattern)!;
const owner = { id: 7n };
const auth = { owner, accountHolder: { id: 8n }, impersonated: null } as unknown as MobileAuth;
const input = (params: Record<string, unknown>) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as Record<string, unknown>;
const status = (result: unknown) => (result as { status: number }).status;
const sale = (overrides: Record<string, unknown> = {}) => ({
  id: 5n,
  link_id: 9n,
  seller_id: 7n,
  subscription_id: null,
  flags: 0n,
  can_contact: 1,
  ...overrides,
});
const run = (method: string, pattern: string, params: Record<string, unknown>) =>
  find(method, pattern).run(input({ id: "5", ...params }), auth);
const handedBack = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(HandBackToRails);

beforeEach(() => {
  selectRows.mockReset();
  eligibleToSendEmails.mockReset();
  missedPostsOf.mockReset();
});

describe("member actions", () => {
  const MEMBER_ACTIONS = [
    ["POST", "resend_receipt"],
    ["POST", "change_can_contact"],
    ["POST", "mark_as_shipped"],
    ["POST", "resend_ping"],
    ["GET", "missed_posts"],
    ["GET", "product_purchases"],
    ["PUT", "variant"],
    ["POST", "send_post"],
    ["PUT", "review_response"],
  ] as const;

  it.each(MEMBER_ACTIONS)("registers %s %s behind the mobile_api scope", (method, name) => {
    expect(find(method, `/mobile/sales/:id/${name}`).scopes).toEqual(["mobile_api"]);
  });

  it.each(MEMBER_ACTIONS)("answers 404 for %s %s of a sale that is not the seller's", async (method, name) => {
    selectRows.mockResolvedValueOnce([]);
    const result = await run(method, `/mobile/sales/:id/${name}`, {});
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
  });

  it("hands mark_as_shipped of a sale that exists to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    await handedBack(run("POST", "/mobile/sales/:id/mark_as_shipped", {}));
  });
});

describe("POST /mobile/sales/:id/resend_ping", () => {
  const action = "/mobile/sales/:id/resend_ping";

  beforeEach(() => performAsync.mockReset());

  it("enqueues the ping of a sale without URL parameters ten seconds out", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([]);
    expect(body(await run("POST", action, {}))).toEqual({ success: true });
    expect(performAsync).toHaveBeenCalledExactlyOnceWith("PostToPingEndpointsWorker", [5, null], { delaySeconds: 10 });
  });

  it("pings for the giftee's purchase when the sale is a gift's sender", async () => {
    selectRows
      .mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_gift_sender_purchase", true) })])
      .mockResolvedValueOnce([{ giftee_purchase_id: 6n }])
      .mockResolvedValueOnce([]);
    await run("POST", action, {});
    expect(performAsync).toHaveBeenCalledExactlyOnceWith("PostToPingEndpointsWorker", [6, null], { delaySeconds: 10 });
  });

  it("enqueues nothing for a gift whose giftee has not purchased", async () => {
    selectRows
      .mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_gift_sender_purchase", true) })])
      .mockResolvedValueOnce([{ giftee_purchase_id: null }]);
    expect(body(await run("POST", action, {}))).toEqual({ success: true });
    expect(performAsync).not.toHaveBeenCalled();
  });

  it("passes the URL parameters of the sale to the job as url_params", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ params: '{"discord_id": "42"}' }]);
    expect(body(await run("POST", action, {}))).toEqual({ success: true });
    expect(performAsync).toHaveBeenCalledExactlyOnceWith("PostToPingEndpointsWorker", [5, { discord_id: "42" }], {
      delaySeconds: 10,
    });
  });

  it("reads URL parameters the driver already parsed", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ params: { plan: "pro" } }]);
    await run("POST", action, {});
    expect(performAsync).toHaveBeenCalledExactlyOnceWith("PostToPingEndpointsWorker", [5, { plan: "pro" }], {
      delaySeconds: 10,
    });
  });

  it("looks the URL parameters up under the giftee's purchase for a gift's sender", async () => {
    selectRows
      .mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_gift_sender_purchase", true) })])
      .mockResolvedValueOnce([{ giftee_purchase_id: 6n }])
      .mockResolvedValueOnce([{ params: '{"a": "b"}' }]);
    await run("POST", action, {});
    expect(performAsync).toHaveBeenCalledExactlyOnceWith("PostToPingEndpointsWorker", [6, { a: "b" }], {
      delaySeconds: 10,
    });
  });

  it("hands several URL parameter rows and values that are not text to Rails before enqueuing", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ params: "{}" }, { params: "{}" }]);
    await handedBack(run("POST", action, {}));
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ params: '{"n": 1}' }]);
    await handedBack(run("POST", action, {}));
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ params: '["a"]' }]);
    await handedBack(run("POST", action, {}));
    expect(performAsync).not.toHaveBeenCalled();
  });
});

describe("POST /mobile/sales/:id/change_can_contact", () => {
  const action = "/mobile/sales/:id/change_can_contact";

  beforeEach(() => {
    changeCanContact.mockReset();
    setPurchase.mockReset().mockResolvedValue({ id: 5n });
  });

  it("answers success once the purchase is saved", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    changeCanContact.mockResolvedValue("changed");
    expect(body(await run("POST", action, { id: "5", can_contact: "false" }))).toEqual({ success: true });
    expect(changeCanContact).toHaveBeenCalledWith({ id: 5n }, "false");
  });

  it("hands a change Node cannot prove to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    changeCanContact.mockRejectedValue(new HandBackToRails("a purchase that has a review"));
    await handedBack(run("POST", action, { id: "5", can_contact: "false" }));
  });
});

describe("POST /mobile/sales/:id/resend_receipt", () => {
  const action = "/mobile/sales/:id/resend_receipt";

  beforeEach(() => {
    resendReceipt.mockReset();
    setPurchase.mockReset().mockResolvedValue({ id: 5n });
  });

  it("answers success once the receipt is enqueued, with no enqueue error rescued", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    resendReceipt.mockResolvedValue("sent");
    expect(body(await run("POST", action, { id: "5" }))).toEqual({ success: true });
    expect(resendReceipt).toHaveBeenCalledWith({ id: 5n }, { rescueEnqueueError: false });
  });

  it("answers 404 when there is no email to send to", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    resendReceipt.mockResolvedValue("missing");
    const result = await run("POST", action, { id: "5" });
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find receipt" });
  });

  it("hands a receipt Node cannot enqueue to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    resendReceipt.mockRejectedValue(new HandBackToRails("a gift sender receipt"));
    await handedBack(run("POST", action, { id: "5" }));
  });
});

describe("GET /mobile/sales/:id/product_purchases", () => {
  const action = "/mobile/sales/:id/product_purchases";

  it("lists nothing for a sale that is not a bundle", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    expect(body(await run("GET", action, {}))).toEqual({ success: true, product_purchases: [] });
  });

  it("hands a bundle to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_bundle_purchase", true) })]);
    await handedBack(run("GET", action, {}));
  });
});

describe("GET /mobile/sales/:id/missed_posts", () => {
  const action = "/mobile/sales/:id/missed_posts";

  it("renders the posts the customer has not been sent, read off the full purchase row", async () => {
    const row = { id: 5n, email: "buyer@example.com" };
    const posts = [
      { id: "abc", name: "Update", url: "http://example.com/p/update", published_at: "2026-11-10T12:00:00.000Z" },
    ];
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([row]);
    missedPostsOf.mockResolvedValueOnce(posts);
    expect(body(await run("GET", action, {}))).toEqual({ success: true, missed_posts: posts });
    expect(missedPostsOf).toHaveBeenCalledWith(row);
  });

  it("lists nothing when the posts query finds none", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ id: 5n }]);
    missedPostsOf.mockResolvedValueOnce([]);
    expect(body(await run("GET", action, {}))).toEqual({ success: true, missed_posts: [] });
  });

  it("hands Rails what the posts query cannot evaluate", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ id: 5n }]);
    missedPostsOf.mockRejectedValueOnce(new HandBackToRails("a filter"));
    await handedBack(run("GET", action, {}));
  });

  it("hands a sale that vanished between the two reads to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([]);
    await handedBack(run("GET", action, {}));
    expect(missedPostsOf).not.toHaveBeenCalled();
  });
});

describe("PUT /mobile/sales/:id", () => {
  const params = { giftee_email: "giftee@example.com" };

  it("registers PUT and PATCH", () => {
    expect(find("PUT", "/mobile/sales/:id")).toBeDefined();
    expect(find("PATCH", "/mobile/sales/:id")).toBeDefined();
  });

  it("answers 422 when giftee_email is sent for a sale that is not a gift", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    const result = await run("PATCH", "/mobile/sales/:id", params);
    expect(status(result)).toBe(422);
    expect(body(result)).toEqual({ success: false, message: "This sale is not a gift" });
  });

  it("answers 422 when the gift has no giftee purchase", async () => {
    selectRows
      .mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_gift_sender_purchase", true) })])
      .mockResolvedValueOnce([{ giftee_purchase_id: null }]);
    const result = await run("PATCH", "/mobile/sales/:id", params);
    expect(status(result)).toBe(422);
    expect(body(result).message).toBe("This gift is missing a giftee purchase");
  });

  it("hands a gift that has its giftee purchase to Rails", async () => {
    selectRows
      .mockResolvedValueOnce([sale({ flags: PurchaseFlags.set(0n, "is_gift_sender_purchase", true) })])
      .mockResolvedValueOnce([{ giftee_purchase_id: 12n }])
      .mockResolvedValueOnce([{ one: 1 }]);
    await handedBack(run("PATCH", "/mobile/sales/:id", params));
  });

  it("hands an update that saves the purchase to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    await handedBack(run("PUT", "/mobile/sales/:id", { full_name: "Ada" }));
  });

  it("hands an email that is not a string to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    await handedBack(run("PUT", "/mobile/sales/:id", { email: ["a@example.com"] }));
  });
});

describe("PUT /mobile/sales/:id/variant", () => {
  const action = "/mobile/sales/:id/variant";

  it("answers 404 for a sale without a product", async () => {
    selectRows.mockResolvedValueOnce([sale({ link_id: null })]);
    const result = await run("PUT", action, { variant_id: "1" });
    expect(status(result)).toBe(404);
    expect(body(result).message).toBe("Could not find product");
  });

  it("answers 404 for a variant id that does not decrypt", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    const result = await run("PUT", action, { variant_id: "nope" });
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Variant not found" });
  });

  it("answers 404 when no variant has that id", async () => {
    selectRows
      .mockResolvedValueOnce([sale()])
      .mockResolvedValueOnce([{ flags: 0 }])
      .mockResolvedValueOnce([]);
    expect(status(await run("PUT", action, { variant_id: "3" }))).toBe(404);
  });

  it("answers 404 for a variant of another product", async () => {
    selectRows
      .mockResolvedValueOnce([sale()])
      .mockResolvedValueOnce([{ flags: 0 }])
      .mockResolvedValueOnce([{ link_id: null, variant_category_id: 4 }])
      .mockResolvedValueOnce([{ link_id: 99 }]);
    expect(status(await run("PUT", action, { variant_id: "3" }))).toBe(404);
  });

  it("hands a variant of the sale's product to Rails", async () => {
    selectRows
      .mockResolvedValueOnce([sale()])
      .mockResolvedValueOnce([{ flags: 0 }])
      .mockResolvedValueOnce([{ link_id: null, variant_category_id: 4 }])
      .mockResolvedValueOnce([{ link_id: 9 }]);
    await handedBack(run("PUT", action, { variant_id: "3" }));
  });

  it("looks a SKU up by product when the product has SKUs enabled", async () => {
    selectRows
      .mockResolvedValueOnce([sale()])
      .mockResolvedValueOnce([{ flags: 1 << 9 }])
      .mockResolvedValueOnce([{ link_id: 99, variant_category_id: null }]);
    expect(status(await run("PUT", action, { variant_id: "3" }))).toBe(404);
  });
});

describe("POST /mobile/sales/:id/send_post", () => {
  const action = "/mobile/sales/:id/send_post";

  it("answers 401 for a seller who cannot email their audience", async () => {
    selectRows.mockResolvedValueOnce([sale()]);
    eligibleToSendEmails.mockResolvedValueOnce(false);
    const result = await run("POST", action, { post_id: "2" });
    expect(status(result)).toBe(401);
    expect(body(result).message).toBe("You are not eligible to resend this email.");
  });

  it("answers 404 for a post that is not the seller's", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([]);
    eligibleToSendEmails.mockResolvedValueOnce(true);
    const result = await run("POST", action, { post_id: "2" });
    expect(status(result)).toBe(404);
    expect(body(result).message).toBe("Could not find post");
  });

  it("answers 422 for a customer who unsubscribed", async () => {
    selectRows.mockResolvedValueOnce([sale({ can_contact: 0 })]).mockResolvedValueOnce([{ one: 1 }]);
    eligibleToSendEmails.mockResolvedValueOnce(true);
    const result = await run("POST", action, { post_id: "2" });
    expect(status(result)).toBe(422);
    expect(body(result).message).toBe("This customer has unsubscribed from your emails.");
  });

  it("hands the email of a post to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ one: 1 }]);
    eligibleToSendEmails.mockResolvedValueOnce(true);
    await handedBack(run("POST", action, { post_id: "2" }));
  });
});

describe("PUT /mobile/sales/:id/review_response", () => {
  const action = "/mobile/sales/:id/review_response";

  it("answers 404 when the sale has no review", async () => {
    selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([]);
    const result = await run("PUT", action, { message: "Thanks" });
    expect(status(result)).toBe(404);
    expect(body(result).message).toBe("Could not find review");
  });

  describe("with a review", () => {
    beforeEach(() => {
      findResponseOfReview.mockReset();
      createResponse.mockReset();
      updateResponse.mockReset();
      selectRows.mockResolvedValueOnce([sale()]).mockResolvedValueOnce([{ id: 11n }]);
    });

    it("creates the first reply for the account holder", async () => {
      findResponseOfReview.mockResolvedValue(null);
      createResponse.mockResolvedValue({ persisted: true });
      expect(body(await run("PUT", action, { message: "Thanks" }))).toEqual({ success: true });
      expect(createResponse).toHaveBeenCalledExactlyOnceWith({
        product_review_id: 11n,
        user_id: 8n,
        message: "Thanks",
      });
    });

    it("updates an earlier reply", async () => {
      const existing = { errors: { isEmpty: () => true } };
      findResponseOfReview.mockResolvedValue(existing);
      updateResponse.mockResolvedValue(true);
      expect(body(await run("PUT", action, { message: "Again" }))).toEqual({ success: true });
      expect(updateResponse).toHaveBeenCalledExactlyOnceWith(existing, { user_id: 8n, message: "Again" });
      expect(createResponse).not.toHaveBeenCalled();
    });

    it("answers 422 with the error when the reply has no message", async () => {
      findResponseOfReview.mockResolvedValue(null);
      createResponse.mockResolvedValue({
        persisted: false,
        errors: { fullMessages: () => ["Message can't be blank"] },
      });
      const result = await run("PUT", action, {});
      expect(status(result)).toBe(422);
      expect(body(result)).toEqual({ success: false, message: "Message can't be blank" });
    });

    it("hands a message that is not a string to Rails", async () => {
      await handedBack(run("PUT", action, { message: ["a"] }));
    });
  });

  it("hands a subscription sale to Rails", async () => {
    selectRows.mockResolvedValueOnce([sale({ subscription_id: 3n })]);
    await handedBack(run("PUT", action, { message: "Thanks" }));
  });
});

describe("GET /mobile/sales/blob_url", () => {
  const action = "/mobile/sales/blob_url";
  const call = (key: unknown) => find("GET", action).run(input({ key }), auth);

  it("answers 404 for a key with no blob", async () => {
    selectRows.mockResolvedValueOnce([]);
    const result = await call("missing");
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find file" });
  });

  it("answers 404 for a blob the seller does not own", async () => {
    selectRows
      .mockResolvedValueOnce([{ id: 1n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    expect(status(await call("k"))).toBe(404);
  });

  it("hands a blob attached to a commission of the seller to Rails", async () => {
    selectRows.mockResolvedValueOnce([{ id: 1n }]).mockResolvedValueOnce([{ one: 1 }]);
    await handedBack(call("k"));
  });

  it("hands a key that is not a string to Rails", async () => {
    await handedBack(call(["k"]));
  });
});
