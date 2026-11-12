// The Circle failure Rails cannot be recorded through WebMock here: a request that never gets an answer. Ruby raises and Sidekiq runs
// the job again from the start; Node hands the job back so Rails does, and throws nothing else after the call.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/redis.ts", async () => ({
  getRedis: (await import("../../worker/jobs/__fixtures__/ratelimit-redis.ts")).getRedis,
}));

const { addMember, removeMember, circleHeader } = await import("./circle-api.ts");

afterEach(() => vi.unstubAllGlobals());

describe("CircleApi", () => {
  it("hands the job back when add_member gets no answer", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(addMember("key1", "100", "200", "buyer@example.com")).rejects.toMatchObject({
      name: "HandBackToRuby",
    });
  });

  it("hands the job back when remove_member gets no answer", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(removeMember("key1", "100", "buyer@example.com")).rejects.toMatchObject({ name: "HandBackToRuby" });
  });

  it("does not read the answer's body", async () => {
    const answer = new Response("not json at all", { status: 502, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", () => Promise.resolve(answer));
    await expect(removeMember("key1", "100", "buyer@example.com")).resolves.toBeUndefined();
  });

  it.each([null, "", "k e y", "key\r\nX-Injected: 1"])("hands back an api key of %j before any request", (key) => {
    expect(() => circleHeader(key)).toThrow(/Handed back to Rails/u);
  });
});
