import { describe, expect, it } from "vitest";

import type { ChatApi, ChatRequest } from "./prompt-strategy.ts";
import { PromptStrategy } from "./prompt-strategy.ts";
import { ADULT_CONTENT_RULES, SPAM_RULES } from "./prompt-rules.ts";
import { OpenAiRequestError } from "./openai-request-error.ts";

const SECRET = "test-secret-key-base";
// The preset and judge calls share a model, so the judge is recognised by its system prompt.
function isJudgeRequest(request: ChatRequest): boolean {
  return String(request.messages[0]?.content).startsWith("You are a meta-evaluator");
}

// `preset` is decided from the system prompt. `flag(preset, call)` says whether that call flags.
function fakeChat(
  flag: (preset: string, call: number) => { flagged: boolean; reasoning?: string } | "error",
  judgeUncertain = false,
) {
  const requests: ChatRequest[] = [];
  const api: ChatApi = {
    async chat(request) {
      requests.push(request);
      const system = typeof request.messages[0]?.content === "string" ? request.messages[0].content : "";
      if (isJudgeRequest(request)) {
        return completion({ uncertain: judgeUncertain });
      }
      const preset = system.startsWith(SPAM_RULES) ? "spam" : system.startsWith(ADULT_CONTENT_RULES) ? "adult_content" : "off_platform_fulfillment";
      const verdict = flag(preset, requests.length);
      if (verdict === "error") {
        throw new OpenAiRequestError("bad_request", { error: { code: "invalid_image_url", message: "cannot fetch" } });
      }
      return completion({ flagged: verdict.flagged, reasoning: verdict.reasoning ?? `${preset} reasoning` });
    },
  };
  return { api, requests };
}

function completion(body: unknown) {
  return { choices: [{ message: { content: JSON.stringify(body) } }] };
}

function strategy(api: ChatApi, options: { corroborate?: boolean; offPlatform?: boolean } = {}) {
  return new PromptStrategy({
    api,
    apiKey: "key",
    corroborateJudgmentFlags: options.corroborate ?? false,
    checkOffPlatformFulfillment: options.offPlatform ?? false,
  });
}

describe("PromptStrategy", () => {
  it("blocks a spam flag that reproduces on every resample", async () => {
    const { api, requests } = fakeChat((preset) => ({ flagged: preset === "spam", reasoning: "repeated slogans" }));
    const result = await strategy(api, { corroborate: true }).perform({ text: "BUY NOW BUY NOW", secretKeyBase: SECRET });

    expect(result.status).toBe("flagged");
    expect(result.reasoning).toEqual(["spam: repeated slogans"]);
    expect(requests.filter((request) => !isJudgeRequest(request)).length).toBe(4);
  });

  it("downgrades a spam flag that does not reproduce on resampling to an audit note", async () => {
    const { api } = fakeChat((preset, call) => ({ flagged: preset === "spam" && call === 2, reasoning: "one-off" }));
    const result = await strategy(api, { corroborate: true }).perform({ text: "some listing", secretKeyBase: SECRET });

    expect(result.status).toBe("compliant");
    expect(result.reasoning).toEqual([]);
    expect(result.auditReasoning).toEqual(["spam (uncorroborated, 1/2 samples flagged): one-off"]);
  });

  it("blocks a spam flag without resampling when corroboration is not requested", async () => {
    const { api, requests } = fakeChat((preset) => ({ flagged: preset === "spam" }));
    const result = await strategy(api).perform({ text: "some listing", secretKeyBase: SECRET });

    expect(result.reasoning).toEqual(["spam: spam reasoning"]);
    expect(requests.filter((request) => !isJudgeRequest(request)).length).toBe(2);
  });

  it("does not block when the judge says the moderator hedged", async () => {
    const { api } = fakeChat((preset) => ({ flagged: preset === "spam" }), true);
    const result = await strategy(api).perform({ text: "listing", secretKeyBase: SECRET });

    expect(result).toEqual({ status: "compliant", reasoning: [], auditReasoning: [] });
  });

  it("corroborates an adult-content flag only when the sample carried no image", async () => {
    const { api } = fakeChat((preset, call) => ({ flagged: preset === "adult_content", reasoning: `call ${call}` }));
    const withImage = await strategy(api, { corroborate: true }).perform({
      text: "listing",
      imageUrls: ["https://cdn.example.com/a.png"],
      secretKeyBase: SECRET,
    });

    expect(withImage.reasoning).toEqual(["adult_content: call 1"]);
  });

  it("retries a preset text-only when OpenAI cannot fetch an image", async () => {
    const { api, requests } = fakeChat((preset, call) => {
      if (preset === "adult_content" && call === 1) return "error";
      return { flagged: preset === "adult_content" };
    });
    const result = await strategy(api).perform({
      text: "listing",
      imageUrls: ["https://cdn.example.com/a.png"],
      secretKeyBase: SECRET,
    });

    const retry = requests[1]!;
    expect(Array.isArray(retry.messages[1]?.content) && retry.messages[1]!.content.some((part) => part.type === "image_url")).toBe(false);
    expect(result.reasoning).toEqual(["adult_content: adult_content reasoning"]);
  });

  it("fails open to compliant when the chat request times out", async () => {
    const timingOut: ChatApi = {
      async chat() {
        throw new OpenAiRequestError("timeout");
      },
    };
    expect(await strategy(timingOut).perform({ text: "listing", secretKeyBase: SECRET })).toEqual({
      status: "compliant",
      reasoning: [],
      auditReasoning: [],
    });
  });

  it("skips the chat API when no key is configured", async () => {
    const { api, requests } = fakeChat(() => ({ flagged: true }));
    const keyless = new PromptStrategy({ api, apiKey: null });

    expect(await keyless.perform({ text: "listing", secretKeyBase: SECRET })).toEqual({
      status: "compliant",
      reasoning: [],
      auditReasoning: [],
    });
    expect(requests).toEqual([]);
  });

  it("sends at most three supported images, drawn once for every preset", async () => {
    const images = [
      "https://cdn.example.com/1.png",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.webp",
      "https://cdn.example.com/4.gif",
      "https://cdn.example.com/doc.svg",
    ];
    const { api, requests } = fakeChat(() => ({ flagged: false }));
    await strategy(api).perform({ text: "listing", imageUrls: images, secretKeyBase: SECRET });

    const adultSample = requests[0]!.messages[1]!.content as Array<{ type: string }>;
    const imageParts = adultSample.filter((part) => part.type === "image_url");
    expect(imageParts.length).toBe(3);
    expect(imageParts.map((part) => (part as unknown as { image_url: { url: string } }).image_url.url)).not.toContain(
      "https://cdn.example.com/doc.svg",
    );
  });
});
