// Port of app/services/content_moderation/strategies/prompt_strategy.rb.
// Decision logic only. The chat transport is injected as `ChatApi`; the API key and error
// notification come from the caller. Rails log lines are not reproduced.
import { OpenAiRequestError } from "./openai-request-error.ts";
import { boundedImageUrls } from "./image-selection.ts";
import { isRubyTruthy, rubyToS } from "./ruby.ts";
import {
  ADULT_CONTENT_RULES,
  OFF_PLATFORM_FULFILLMENT_RULES,
  SPAM_RULES,
} from "./prompt-rules.ts";

export type PromptResult = {
  status: "flagged" | "compliant";
  reasoning: string[];
  // Judgment flags that did not reproduce on resampling. Recorded for review, never blocking.
  auditReasoning: string[];
};

export type ChatMessage = { role: "system" | "user"; content: string | ChatContentPart[] };
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  response_format: { type: "json_object" };
  temperature: number;
};

// Resolves to the raw chat completion. Rejects with OpenAiRequestError for the kinds in
// openai-request-error.ts.
export interface ChatApi {
  chat(request: ChatRequest): Promise<unknown>;
}

export type PromptStrategyOptions = {
  api: ChatApi;
  apiKey: string | null;
  // Receives the OpenAI 400 notifications that ErrorNotifier.notify would send.
  notify?: (message: string, context: Record<string, unknown>) => void;
  // Lets a non-default caller run without the judgment-preset corroboration.
  corroborateJudgmentFlags?: boolean;
  checkOffPlatformFulfillment?: boolean;
};

export type PromptInput = {
  text: string;
  imageUrls?: readonly string[];
  secretKeyBase: string;
};

export const OPENAI_REQUEST_TIMEOUT_IN_SECONDS = 10;
export const CORROBORATION_RESAMPLES = 2;
export const MODEL = "gpt-4o-mini";
export const JUDGE_MODEL = "gpt-4o-mini";
export const MAX_IMAGES_PER_PRESET = 3;
export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Judgment presets that must reproduce on resampling before they may block a publish.
const CORROBORATED_PRESETS: ReadonlySet<string> = new Set(["spam", "off_platform_fulfillment"]);
// Adult-content flags are corroborated only when no picture reached the model.
const TEXT_ONLY_CORROBORATED_PRESETS: ReadonlySet<string> = new Set(["adult_content"]);

const TRANSIENT_KINDS: ReadonlySet<string> = new Set(["timeout", "connection", "parsing", "server"]);
const PERMANENT_IMAGE_REFUSAL_CODE = "invalid_image_url";
const RESPONSE_FORMAT = { type: "json_object" } as const;
const JUDGE_SYSTEM_PROMPT =
  'You are a meta-evaluator. Given a content moderation reasoning, determine if the moderator expressed uncertainty or hedging. Respond with JSON: {"uncertain": true/false}';

type Preset = { name: string; rules: string; skipImages: boolean };
type NotifyFn = (message: string, context: Record<string, unknown>) => void;

export class PromptStrategy {
  private readonly api: ChatApi;
  private readonly apiKey: string | null;
  private readonly notify: NotifyFn;
  private readonly corroborate: boolean;
  private readonly checkOffPlatform: boolean;

  constructor(options: PromptStrategyOptions) {
    this.api = options.api;
    this.apiKey = options.apiKey;
    this.notify = options.notify ?? (() => {});
    this.corroborate = options.corroborateJudgmentFlags ?? false;
    this.checkOffPlatform = options.checkOffPlatformFulfillment ?? false;
  }

  async perform(input: PromptInput): Promise<PromptResult> {
    const imageUrls = input.imageUrls ?? [];
    const run = new PromptRun(this.api, this.notify, input.text, imageUrls, input.secretKeyBase);

    if (isBlank(input.text) && imageUrls.length === 0) return compliant();
    if (isBlank(this.apiKey)) return compliant();

    const allReasoning: string[] = [];
    const auditReasoning: string[] = [];

    try {
      for (const preset of this.presets()) {
        if (run.emptyPayload(preset)) continue;

        const result = await run.evaluatePreset(preset, preset.skipImages);
        if (result.status === "compliant") continue;
        if (!(await run.passesUncertaintyCheck(result.reasoning))) continue;

        if (this.corroborate && corroboratedPreset(preset, result.imagesSent)) {
          const [flaggedResamples, resamplesRun] = await run.runResamples(preset, !result.imagesSent);
          const corroborated = flaggedResamples === CORROBORATION_RESAMPLES;
          if (!corroborated) {
            auditReasoning.push(
              `${preset.name} (uncorroborated, ${flaggedResamples + 1}/${resamplesRun + 1} samples flagged): ${result.reasoning}`,
            );
            continue;
          }
        }

        allReasoning.push(`${preset.name}: ${result.reasoning}`);
      }
    } catch (error) {
      // Transient transport failures fail open, toward publishing. Anything else propagates.
      if (error instanceof OpenAiRequestError && TRANSIENT_KINDS.has(error.kind)) {
        return compliant();
      }
      throw error;
    }

    if (allReasoning.length > 0) return { status: "flagged", reasoning: allReasoning, auditReasoning };
    return { status: "compliant", reasoning: [], auditReasoning };
  }

  private presets(): Preset[] {
    const list: Preset[] = [
      { name: "adult_content", rules: ADULT_CONTENT_RULES, skipImages: false },
      { name: "spam", rules: SPAM_RULES, skipImages: true },
    ];
    if (this.checkOffPlatform) {
      list.push({ name: "off_platform_fulfillment", rules: OFF_PLATFORM_FULFILLMENT_RULES, skipImages: true });
    }
    return list;
  }
}

// Per-perform state. The sampled images are drawn once so every preset, resample and text-only
// retry reasons about the same pictures.
class PromptRun {
  private sampled: string[] | null = null;

  constructor(
    private readonly api: ChatApi,
    private readonly notify: NotifyFn,
    private readonly text: string,
    private readonly imageUrls: readonly string[],
    private readonly secretKeyBase: string,
  ) {}

  emptyPayload(preset: Preset): boolean {
    return isBlank(this.text) && (preset.skipImages || this.sampledImageUrls().length === 0);
  }

  async evaluatePreset(
    preset: Preset,
    skipImages: boolean,
  ): Promise<{ status: "flagged" | "compliant"; reasoning: string; imagesSent: boolean }> {
    const messages = this.buildMessages(preset.rules, skipImages);
    let response: unknown;
    try {
      response = await this.api.chat({
        model: MODEL,
        messages,
        response_format: RESPONSE_FORMAT,
        temperature: 0.1,
      });
    } catch (error) {
      if (error instanceof OpenAiRequestError && error.kind === "bad_request") {
        // OpenAI cannot always fetch our signed image URLs. Retry once text-only, so the text is
        // still moderated instead of passing with no evaluation.
        if (errorCode(error) === PERMANENT_IMAGE_REFUSAL_CODE && !skipImages) {
          return this.evaluatePreset(preset, true);
        }
        this.notifyRejection(error, `preset:${preset.name}`, !skipImages);
        return { status: "compliant", reasoning: "", imagesSent: false };
      }
      if (error instanceof OpenAiRequestError && TRANSIENT_KINDS.has(error.kind)) {
        return { status: "compliant", reasoning: "", imagesSent: false };
      }
      throw error;
    }

    const parsed = JSON.parse(messageContent(response)) as { flagged?: unknown; reasoning?: unknown };
    return {
      status: isRubyTruthy(parsed.flagged) ? "flagged" : "compliant",
      reasoning: rubyToS(parsed.reasoning),
      imagesSent: this.imagesSent(skipImages),
    };
  }

  // Asks the judge model whether the moderator hedged. A hedged reason never blocks.
  async passesUncertaintyCheck(reasoning: string): Promise<boolean> {
    let response: unknown;
    try {
      response = await this.api.chat({
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: `Moderation reasoning: ${reasoning}` },
        ],
        response_format: RESPONSE_FORMAT,
        temperature: 0,
      });
    } catch (error) {
      if (error instanceof OpenAiRequestError && error.kind === "bad_request") {
        this.notifyRejection(error, "uncertainty_check", false);
        return false;
      }
      if (error instanceof OpenAiRequestError && TRANSIENT_KINDS.has(error.kind)) return false;
      throw error;
    }

    const parsed = JSON.parse(messageContent(response)) as { uncertain?: unknown };
    return !isRubyTruthy(parsed.uncertain);
  }

  // Returns [flagged resamples, resamples run]. The first clean one decides it.
  async runResamples(preset: Preset, skipImages: boolean): Promise<[number, number]> {
    let flagged = 0;
    let run = 0;
    for (let i = 0; i < CORROBORATION_RESAMPLES; i += 1) {
      run += 1;
      const result = await this.evaluatePreset(preset, skipImages);
      if (result.status !== "flagged") break;
      flagged += 1;
    }
    return [flagged, run];
  }

  sampledImageUrls(): string[] {
    if (this.sampled === null) {
      const supported = this.imageUrls.filter((url) => isSupportedImageUrl(url));
      this.sampled = boundedImageUrls(supported, MAX_IMAGES_PER_PRESET, this.secretKeyBase);
    }
    return this.sampled;
  }

  private imagesSent(skipImages: boolean): boolean {
    return !skipImages && this.sampledImageUrls().length > 0;
  }

  private buildMessages(rules: string, skipImages: boolean): ChatMessage[] {
    const userContent: ChatContentPart[] = [
      { type: "text", text: `Content to evaluate:\n\n${isBlank(this.text) ? "[no text provided]" : this.text}` },
    ];
    if (!skipImages && this.imageUrls.length > 0) {
      for (const url of this.sampledImageUrls()) userContent.push({ type: "image_url", image_url: { url } });
    }
    return [
      { role: "system", content: `${rules}\n\nRespond with JSON: {"flagged": true/false, "reasoning": "explanation"}` },
      { role: "user", content: userContent },
    ];
  }

  private notifyRejection(error: OpenAiRequestError, stage: string, imagesSent: boolean): void {
    const payload = errorPayload(error);
    const message = payload ? String(payload.message ?? "") : rubyToS(bodyOf(error));
    this.notify("ContentModeration::PromptStrategy OpenAI rejected input", {
      stage,
      model: MODEL,
      openai_error_code: errorCode(error),
      openai_error_param: payload?.param ?? null,
      openai_error_message: message.slice(0, 1000),
      text_length: [...this.text].length,
      image_url_count: this.imageUrls.length,
      image_urls_sent: imagesSent ? this.sampledImageUrls() : [],
    });
  }
}

function corroboratedPreset(preset: Preset, imagesSent: boolean): boolean {
  if (CORROBORATED_PRESETS.has(preset.name)) return true;
  if (!TEXT_ONLY_CORROBORATED_PRESETS.has(preset.name)) return false;
  return !imagesSent;
}

function compliant(): PromptResult {
  return { status: "compliant", reasoning: [], auditReasoning: [] };
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}


function bodyOf(error: OpenAiRequestError): unknown {
  return error.body;
}

function errorPayload(error: OpenAiRequestError): { code?: unknown; message?: unknown; param?: unknown } | null {
  const body = bodyOf(error);
  if (body === null || typeof body !== "object") return null;
  const payload = (body as { error?: unknown }).error;
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function errorCode(error: OpenAiRequestError): string | null {
  const code = errorPayload(error)?.code;
  return typeof code === "string" ? code : null;
}

function messageContent(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new TypeError("chat completion has no message content");
  return content;
}

// Ruby File.extname on the last path segment, lower-cased. A leading dot does not start an
// extension, so "/a/.png" has none.
function isSupportedImageUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false;
  return SUPPORTED_IMAGE_EXTENSIONS.includes(basename.slice(dot).toLowerCase());
}
