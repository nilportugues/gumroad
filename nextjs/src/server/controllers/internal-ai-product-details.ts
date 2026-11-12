// Api::Internal::AiProductDetailsGenerationsController#create (POST /internal/ai_product_details_generations): sign-in, the hourly Redis
// throttle, the Pundit check, the prompt filter and the model call of Ai::ProductDetailsGeneratorService#generate_product_details.
// Rack::Attack's per-address rule is counted ahead of this by the single counter (rack-attack.ts).
import { chatCompletionText } from "../ai/openai-chat.ts";
import { productDetailsMessages } from "../ai/product-details-prompts.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { getRedis } from "../infra/redis.ts";
import LINK_DATA from "../models/link-data.generated.json" with { type: "json" };
import { eligibleForAiProductGeneration } from "../page-props/seller-products/new-page.ts";
import { NotAuthorizedError } from "../policies/seller-context.ts";
import { userPolicy } from "../policies/user.ts";

import { rubyToS } from "./api-v2/ruby-params.ts";
import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, notFoundJson } from "./seller-json.ts";

const AI_REQUESTS_PER_PERIOD = 10;
const AI_REQUESTS_PERIOD_WINDOW_SECONDS = 3600;
const SECONDS_PER_MINUTE = 60;
const PRODUCT_DETAILS_GENERATION_TIMEOUT_IN_SECONDS = 30;
const MAX_TRIES = 2;
const RETRY_DELAY_MS = 1000;
const TOO_MANY_REQUESTS = 429;
const BAD_REQUEST = 400;
const INTERNAL_SERVER_ERROR = 500;
const CURRENCY_CHOICES = Object.keys(LINK_DATA.currencies);
// A word-bounded verb followed by what it refers to. Ruby's \b is Unicode-aware while its \w and \s are ASCII, so the boundary is spelled out.
const WORD = String.raw`\p{L}\p{M}\p{N}\p{Pc}`;
const INJECTION = new RegExp(
  `(?<![${WORD}])(ignore|forget|system|assistant|user|delete|remove|clear|impersonate)[ \\t\\r\\n\\f\\v]+(previous|above|all)(?![${WORD}])`,
  "giu",
);
const NOT_ALLOWED_CHARACTERS = /[^A-Za-z0-9_ \t\r\n\f\v.,!?\-[\]]/gu;
const RUBY_STRIP = /^[\0\t-\r ]+|[\0\t-\r ]+$/gu;

// Throttling::OPEN_WINDOW_SCRIPT
const OPEN_WINDOW_SCRIPT = `local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count
`;

// Throttling#ttl_to_retry_after
async function retryAfter(key: string): Promise<number> {
  const redis = getRedis("main");
  const ttl = await redis.ttl(key);
  if (ttl > 0) return ttl;
  if (ttl === 0 || ttl === -2) return 0;
  await redis.expire(key, AI_REQUESTS_PERIOD_WINDOW_SECONDS);
  return AI_REQUESTS_PERIOD_WINDOW_SECONDS;
}

function throttleMessage(retry: number): string {
  let timing = "You can generate again now.";
  if (retry > 0) {
    const minutes = Math.max(Math.ceil(retry / SECONDS_PER_MINUTE), 1);
    timing = `You can generate again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return `You've used all ${AI_REQUESTS_PER_PERIOD} AI generations for this hour. ${timing}`;
}

export function sanitizePrompt(prompt: string): string {
  return prompt.replace(INJECTION, "[FILTERED]").replace(NOT_ALLOWED_CHARACTERS, "").replace(RUBY_STRIP, "");
}

// A parsed model answer that keeps what Ruby's JSON.parse tells apart: a number written with a fraction or exponent is a Float.
type Tagged =
  | { kind: "float"; value: number }
  | { kind: "integer"; text: string }
  | { kind: "array"; items: Tagged[] }
  | { kind: "object"; entries: Map<string, Tagged> }
  | { kind: "scalar"; value: string | boolean | null };

function parseTagged(content: string): Tagged {
  const tag = (value: unknown, source: string | undefined): Tagged => {
    if (typeof value === "number") {
      if (source !== undefined && /[.eE]/u.test(source)) return { kind: "float", value };
      return { kind: "integer", text: source === undefined ? String(value) : String(BigInt(source)) };
    }
    return { kind: "scalar", value: value as string | boolean | null };
  };
  const tree = JSON.parse(content, (_key, value: unknown, context?: { source?: string }) => {
    if (Array.isArray(value)) return { kind: "array", items: value as Tagged[] } satisfies Tagged;
    if (value !== null && typeof value === "object")
      return { kind: "object", entries: new Map(Object.entries(value as Record<string, Tagged>)) } satisfies Tagged;
    return tag(value, context?.source);
  }) as Tagged;
  return tree;
}

// Float#to_s
export function rubyFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("a non-finite float");
  if (Object.is(value, -0)) return "-0.0";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
    const sign = Number(exponent) < 0 ? "-" : "+";
    return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}e${sign}${String(Math.abs(Number(exponent))).padStart(2, "0")}`;
  }
  const text = String(value);
  return text.includes(".") ? text : `${text}.0`;
}

// ActiveSupport's JSON encoding of a string: the HTML-unsafe characters are escaped.
const jsonString = (text: string) =>
  JSON.stringify(text).replace(/[<>&\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function render(node: Tagged): string {
  switch (node.kind) {
    case "float":
      return rubyFloat(node.value);
    case "integer":
      return node.text;
    case "array":
      return `[${node.items.map(render).join(",")}]`;
    case "object":
      return `{${[...node.entries].map(([key, value]) => `${jsonString(key)}:${render(value)}`).join(",")}}`;
    case "scalar":
      return typeof node.value === "string" ? jsonString(node.value) : JSON.stringify(node.value);
  }
}

class GenerationFailed extends Error {}

async function askModel(currencyType: string, prompt: string): Promise<Tagged> {
  const messages = productDetailsMessages({ currencyType, currencyChoices: CURRENCY_CHOICES, prompt });
  const parameters = {
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.5,
  };
  for (let tries = 1; ; tries++) {
    try {
      const response = JSON.parse(
        await chatCompletionText(parameters, PRODUCT_DETAILS_GENERATION_TIMEOUT_IN_SECONDS),
      ) as { choices?: { message?: { content?: unknown } }[] };
      const content = response.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new GenerationFailed("no content returned");
      return parseTagged(content);
    } catch (error) {
      if (tries >= MAX_TRIES)
        throw new GenerationFailed(`Failed after ${MAX_TRIES} attempts: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

const RESULT_KEYS = [
  "name",
  "description",
  "summary",
  "number_of_content_pages",
  "price",
  "currency_code",
  "price_frequency_in_months",
  "native_type",
] as const;

async function generate(input: MutationInput): Promise<ActionResult> {
  // authenticate_user!
  if (railsLoggedInUser(input.context) === null) return { ...notFoundJson(), rescued: true };
  const seller = input.context.currentSeller;
  if (seller === null) throw new HandBackToRails("a signed-in request without a current seller");

  // throttle_ai_requests
  const key = `ai_request_throttle:${seller.id}`;
  const count = Number(
    await getRedis("main").eval(OPEN_WINDOW_SCRIPT, 1, key, String(AI_REQUESTS_PERIOD_WINDOW_SECONDS)),
  );
  if (count > AI_REQUESTS_PER_PERIOD) {
    const retry = await retryAfter(key);
    return {
      ...json({ error: throttleMessage(retry), retry_after: retry }, TOO_MANY_REQUESTS),
      headers: { "Retry-After": String(retry) },
      rescued: true,
    };
  }

  // authorize current_seller, :generate_product_details_with_ai?
  const denied = await authorizeJson(input, async (context) => {
    if (!userPolicy.generateProductDetailsWithAi(context, await eligibleForAiProductGeneration(seller)))
      throw new NotAuthorizedError("not allowed to generate_product_details_with_ai?");
  });
  if (denied) return denied;

  const prompt = sanitizePrompt(rubyToS(input.params.prompt));
  if (prompt === "") return json({ error: "Prompt is required" }, BAD_REQUEST);

  const started = performance.now();
  try {
    const result = await askModel(seller.currency_type ?? "usd", prompt);
    if (result.kind !== "object") throw new TypeError("undefined method 'merge'");
    const duration = (performance.now() - started) / 1000;
    const data = RESULT_KEYS.map(
      (name) => `${jsonString(name)}:${result.entries.has(name) ? render(result.entries.get(name)!) : "null"}`,
    );
    data.push(`"duration_in_seconds":${rubyFloat(duration)}`);
    return {
      status: 200,
      body: `{"success":true,"data":{${data.join(",")}}}`,
      contentType: "application/json; charset=utf-8",
      paramsRead: true,
    };
  } catch (error) {
    notifyError(error);
    return json(
      { success: false, error: "Failed to generate product details. Please try again." },
      INTERNAL_SERVER_ERROR,
    );
  }
}

registerMutations({
  method: "POST",
  pattern: "/internal/ai_product_details_generations",
  formats: ["any"],
  run: generate,
});
