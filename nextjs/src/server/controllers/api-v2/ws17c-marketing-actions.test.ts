import { beforeAll, describe, expect, it } from "vitest";

import { HandBackToRails } from "../application-controller.ts";

import type { ApiCall } from "./ws17c-base.ts";

beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "marketing-actions-api-test-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";
});

const { create, execute, recommendations } = await import("./ws17c-marketing-actions.ts");

const withParams = (params: Record<string, unknown>, channel?: string) =>
  ({
    params,
    routeParams: {},
    state: { action: { get: (key: string) => (key === "channel" ? channel : undefined) } },
  }) as unknown as ApiCall;
const message = (result: unknown) =>
  (JSON.parse(String((result as { body: string }).body)) as { message: string }).message;

describe("Api::V2::MarketingActionsController#create channel checks", () => {
  it("answers 422 for a missing, unknown, list-valued or abandoned cart channel", async () => {
    for (const channel of [undefined, "myspace", ["x"], { a: "x" }, 7, "abandoned_cart"]) {
      const result = await create(withParams(channel === undefined ? {} : { channel }));
      expect((result as { status: number }).status).toBe(422);
      expect(message(result)).toBe("Unknown marketing channel.");
    }
  });

  it("says the channels that are not live are coming soon", async () => {
    for (const channel of ["instagram", "youtube", "tiktok"])
      expect(message(await create(withParams({ channel })))).toBe("This channel is coming soon.");
  });

  it("hands a live channel back, because creating its action writes a UTM link and a draft", async () => {
    for (const channel of ["x", "email"])
      await expect(create(withParams({ channel }))).rejects.toThrow(HandBackToRails);
  });
});

describe("Api::V2::MarketingActionsController#execute", () => {
  it("answers 422 for a channel that is not live", async () => {
    const result = await execute(withParams({}, "instagram"));
    expect((result as { status: number }).status).toBe(422);
    expect(message(result)).toBe("This channel is coming soon.");
  });

  it("hands back a live channel, which posts to X or schedules the email", async () => {
    for (const channel of ["x", "email"])
      await expect(execute(withParams({}, channel))).rejects.toThrow(HandBackToRails);
  });
});

describe("Api::V2::MarketingActionsController#recommendations", () => {
  it("hands back, because it creates the actions and their UTM links", async () => {
    await expect(recommendations()).rejects.toThrow(HandBackToRails);
  });
});
