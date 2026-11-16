import { describe, expect, it } from "vitest";

import {
  ClassifierStrategy,
  DEFAULT_THRESHOLDS,
  loadThresholds,
  MAX_DATA_IMAGE_BYTES,
  type ModerationApi,
  rubyFloatToS,
  UNAVAILABLE_REASON,
  UNFETCHABLE_IMAGE_REASON,
  UNSUPPORTED_IMAGE_REASON,
} from "./classifier-strategy.ts";
import { OpenAiRequestError } from "./openai-request-error.ts";

const S3_BASE = "https://s3.example.com/bucket/";
const SECRET = "test-secret-key-base";

type Call = { input: Array<{ type: string; image_url?: { url: string } }>; timeout: number };

// Answers each call from `respond`, recording every request so tests can count them.
function fakeApi(respond: (input: Call["input"], call: number) => unknown): { api: ModerationApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: ModerationApi = {
    async moderations(request, timeoutSeconds) {
      calls.push({ input: request.input, timeout: timeoutSeconds });
      return respond(request.input, calls.length);
    },
  };
  return { api, calls };
}

const scores = (category_scores: Record<string, number>) => ({ results: [{ category_scores }] });
const imageUrl = (input: Call["input"]) => input[0]?.image_url?.url ?? "";

function strategy(api: ModerationApi, now: () => number = () => 0) {
  return new ClassifierStrategy({
    api,
    apiKey: "key",
    thresholds: DEFAULT_THRESHOLDS,
    secretKeyBase: SECRET,
    s3BaseUrl: S3_BASE,
    now,
  });
}

describe("ClassifierStrategy text moderation", () => {
  it("flags text whose category score reaches its threshold", async () => {
    const { api } = fakeApi(() => scores({ violence: 0.95, hate: 0.1 }));
    const result = await strategy(api).perform({ text: "hello" });

    expect(result).toEqual({
      status: "flagged",
      reasoning: ["OpenAI moderation flagged: violence (score: 0.95, threshold: 0.9)"],
    });
  });

  it("passes text whose scores stay under every threshold", async () => {
    const { api } = fakeApi(() => scores({ violence: 0.2, "sexual/minors": 0.2 }));
    expect(await strategy(api).perform({ text: "hello" })).toEqual({ status: "compliant", reasoning: [] });
  });

  it("uses the lower threshold for sexual/minors, which trips at 0.3", async () => {
    const { api } = fakeApi(() => scores({ "sexual/minors": 0.31 }));
    const result = await strategy(api).perform({ text: "hello" });
    expect(result.reasoning).toEqual(["OpenAI moderation flagged: sexual/minors (score: 0.31, threshold: 0.3)"]);
  });

  it("fails closed with the unavailable reason when the response carries no scores", async () => {
    const { api } = fakeApi(() => ({ results: [] }));
    expect(await strategy(api).perform({ text: "hello" })).toEqual({ status: "flagged", reasoning: [UNAVAILABLE_REASON] });
  });

  it("retries a transient failure and gives up after three attempts", async () => {
    const { api, calls } = fakeApi(() => {
      throw new OpenAiRequestError("timeout");
    });
    const result = await strategy(api).perform({ text: "hello" });

    expect(calls.length).toBe(3);
    expect(result).toEqual({ status: "flagged", reasoning: [UNAVAILABLE_REASON] });
  });

  it("skips the API entirely when no key is configured", async () => {
    const { api, calls } = fakeApi(() => scores({ violence: 1 }));
    const keyless = new ClassifierStrategy({
      api,
      apiKey: null,
      thresholds: DEFAULT_THRESHOLDS,
      secretKeyBase: SECRET,
      s3BaseUrl: S3_BASE,
    });

    expect(await keyless.perform({ text: "hello" })).toEqual({ status: "compliant", reasoning: [] });
    expect(calls).toEqual([]);
  });
});

describe("ClassifierStrategy image moderation", () => {
  it("retries a rejected batch one image at a time so one bad image cannot hide the others", async () => {
    const { api, calls } = fakeApi((input) => {
      if (input.length > 1) throw new OpenAiRequestError("bad_request", { error: { code: "invalid_image_url" } });
      return imageUrl(input).endsWith("b.png") ? scores({ sexual: 0.9 }) : scores({});
    });
    const result = await strategy(api).perform({
      text: "",
      imageUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
      maxImages: 5,
    });

    expect(calls.map((call) => call.input.length)).toEqual([2, 1, 1]);
    expect(result.reasoning).toEqual(["OpenAI moderation flagged: sexual (score: 0.9, threshold: 0.8)"]);
  });

  it("uses the 30 second budget for a batch and the 10 second budget for a single image", async () => {
    const { api, calls } = fakeApi(() => scores({}));
    await strategy(api).perform({
      text: "",
      imageUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
    });
    await strategy(api).perform({ text: "", imageUrls: ["https://cdn.example.com/c.png"] });

    expect(calls[0]?.timeout).toBe(30);
    expect(calls[1]?.timeout).toBe(10);
  });

  it("classifies an unfetchable stored image as a download failure that blocks full coverage", async () => {
    const { api } = fakeApi(() => {
      throw new OpenAiRequestError("bad_request", { error: { code: "image_url_unavailable" } });
    });
    const result = await new ClassifierStrategy({
      api,
      apiKey: "key",
      thresholds: DEFAULT_THRESHOLDS,
      secretKeyBase: SECRET,
      s3BaseUrl: S3_BASE,
    }).perform({ text: "", imageUrls: ["https://cdn.example.com/a.png"], maxImages: "all", imageUrlsAreStored: true });

    expect(result).toEqual({ status: "flagged", reasoning: [UNFETCHABLE_IMAGE_REASON] });
  });

  it("does not block on a refused image when the text was reviewed and no image was moderated", async () => {
    const { api } = fakeApi((input) => {
      if (input[0]?.type === "text") return scores({});
      throw new OpenAiRequestError("bad_request", { error: { code: "invalid_image_format" } });
    });
    const result = await strategy(api).perform({ text: "hello", imageUrls: ["https://cdn.example.com/a.png"] });

    expect(result).toEqual({ status: "compliant", reasoning: [] });
  });

  it("blocks with the unsupported reason when the only image is refused and no text was reviewed", async () => {
    const { api } = fakeApi(() => {
      throw new OpenAiRequestError("bad_request", { error: { code: "file_too_large" } });
    });
    const result = await strategy(api).perform({ text: "", imageUrls: ["https://cdn.example.com/a.png"] });

    expect(result).toEqual({ status: "flagged", reasoning: [UNSUPPORTED_IMAGE_REASON] });
  });

  it("refuses an oversized inline image without sending it", async () => {
    const oversized = `data:image/png;base64,${"A".repeat(MAX_DATA_IMAGE_BYTES + 1)}`;
    const { api, calls } = fakeApi(() => scores({}));
    const result = await strategy(api).perform({ text: "", imageUrls: [oversized], maxImages: "all" });

    expect(calls).toEqual([]);
    expect(result).toEqual({ status: "flagged", reasoning: [UNSUPPORTED_IMAGE_REASON] });
  });

  it("marks an image unreached once the image phase deadline has passed", async () => {
    let clock = 0;
    const { api, calls } = fakeApi(() => scores({}));
    const late = strategy(api, () => {
      clock += 1;
      return clock === 1 ? 0 : 100;
    });
    const result = await late.perform({ text: "", imageUrls: ["https://cdn.example.com/a.png"], maxImages: "all" });

    expect(calls).toEqual([]);
    expect(result).toEqual({ status: "flagged", reasoning: [UNAVAILABLE_REASON] });
  });
});

describe("loadThresholds", () => {
  it("merges custom thresholds over the defaults", () => {
    expect(loadThresholds('{"violence": 0.5}').violence).toBe(0.5);
    expect(loadThresholds('{"violence": 0.5}').hate).toBe(DEFAULT_THRESHOLDS.hate);
  });

  it("falls back to the defaults when the custom value is not JSON", () => {
    expect(loadThresholds("not json")).toEqual(DEFAULT_THRESHOLDS);
    expect(loadThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("rubyFloatToS", () => {
  it("prints whole numbers with one fraction digit, as Ruby does", () => {
    expect(rubyFloatToS(1)).toBe("1.0");
    expect(rubyFloatToS(0.8)).toBe("0.8");
  });

  it("switches to exponent notation below 1e-4", () => {
    expect(rubyFloatToS(0.00001)).toBe("1.0e-05");
  });
});
