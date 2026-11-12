import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = { incr: vi.fn(), eval: vi.fn() };
const performAsync = vi.fn();
vi.mock("../infra/redis.ts", () => ({ getRedis: () => redis }));
vi.mock("./concerns/job-runtime.ts", () => ({ performAsync: (...args: unknown[]) => performAsync(...args) }));

const { enqueueProductsOfferCodesReindex, enqueueSellerOfferCodesReindex } = await import("./offer-code-index.ts");

describe("ReindexSellerOfferCodesJob enqueue helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bumps the catalogue version then queues the seller", async () => {
    await enqueueSellerOfferCodesReindex(3);
    expect(redis.incr).toHaveBeenCalledWith("offer_code_index:3:version");
    expect(performAsync).toHaveBeenCalledWith("ReindexSellerOfferCodesJob", [3]);
  });

  it("runs the Lua script over the three product keys with the product ids as arguments", async () => {
    await enqueueProductsOfferCodesReindex(3, [1n, 7]);
    const [script, keyCount, ...rest] = redis.eval.mock.calls[0]!;
    expect(script).toContain("redis.call('INCR', KEYS[2])");
    expect(keyCount).toBe(3);
    expect(rest).toEqual([
      "offer_code_index:3:products",
      "offer_code_index:3:sequence",
      "offer_code_index:3:product_versions",
      "1",
      "7",
    ]);
    expect(performAsync).toHaveBeenCalledWith("ReindexSellerOfferCodesJob", [3]);
  });

  it("does nothing for an empty product list", async () => {
    await enqueueProductsOfferCodesReindex(3, []);
    expect(redis.eval).not.toHaveBeenCalled();
    expect(performAsync).not.toHaveBeenCalled();
  });

  it("skips the enqueue when Redis is unreachable and lets other errors through", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    redis.incr.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(enqueueSellerOfferCodesReindex(3)).resolves.toBeUndefined();
    expect(performAsync).not.toHaveBeenCalled();
    redis.incr.mockRejectedValueOnce(new Error("bug"));
    await expect(enqueueSellerOfferCodesReindex(3)).rejects.toThrow("bug");
  });
});
