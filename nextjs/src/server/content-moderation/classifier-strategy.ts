// Port of app/services/content_moderation/strategies/classifier_strategy.rb.
// Decision logic only. The OpenAI transport is injected as `ModerationApi`, and API keys,
// thresholds and S3_BASE_URL come from the caller. Rails log lines are not reproduced.
import { OpenAiRequestError, type OpenAiRequestErrorKind } from "./openai-request-error.ts";
import { orderedImageUrls } from "./image-selection.ts";

export type ClassifierResult = { status: "flagged" | "compliant"; reasoning: string[] };

export type CategoryScores = Record<string, number>;

export type ModerationInput =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// Calls the moderations endpoint with one request. Resolves to the raw response object, rejects
// with OpenAiRequestError for the failure kinds in openai-request-error.ts.
export interface ModerationApi {
  moderations(request: { model: string; input: ModerationInput[] }, timeoutSeconds: number): Promise<unknown>;
}

export type ClassifierOptions = {
  api: ModerationApi;
  // OPENAI_ACCESS_TOKEN. Without it nothing is reviewed and the content passes.
  apiKey: string | null;
  thresholds: Record<string, number>;
  // The Rails secret_key_base, which keys the image order (see image-selection.ts).
  secretKeyBase: string;
  // S3_BASE_URL. Private-bucket URLs are never fetchable by OpenAI, so their failures are final.
  s3BaseUrl: string;
  // Monotonic clock in seconds. Injected so the image-phase deadline can be tested.
  now?: () => number;
  // ErrorNotifier.notify.
  notify?: (error: unknown, context: Record<string, unknown>) => void;
};

export type ClassifierInput = {
  text: string;
  imageUrls?: readonly string[];
  // `"all"` (pages) spends an attempt on every image; a number caps the attempts.
  maxImages?: number | "all";
  imageUrlsAreStored?: boolean;
};

export const OPENAI_REQUEST_TIMEOUT_IN_SECONDS = 10;
export const IMAGE_BATCH_REQUEST_TIMEOUT_IN_SECONDS = 30;
export const MAX_MODERATION_ATTEMPTS = 3;
export const IMAGE_PHASE_DEADLINE_IN_SECONDS = 60;
export const MAX_IMAGES_TO_MODERATE = 5;
export const IMAGES_PER_REQUEST = 5;
export const MAX_DATA_IMAGE_BYTES = 200_000;
export const MODERATION_MODEL = "omni-moderation-latest";

export const UNAVAILABLE_REASON =
  "We cannot moderate the content at this time, please try again later or update the content.";
export const UNSUPPORTED_IMAGE_REASON =
  "The content contains an image the moderation endpoint cannot review (unsupported format or too large).";
export const UNFETCHABLE_IMAGE_REASON = "The content contains an image we could not download from its URL.";

export const DEFAULT_THRESHOLDS: Readonly<Record<string, number>> = {
  harassment: 0.8,
  "harassment/threatening": 0.8,
  hate: 0.8,
  "hate/threatening": 0.8,
  illicit: 0.8,
  "illicit/violent": 0.8,
  "self-harm": 0.8,
  "self-harm/intent": 0.8,
  "self-harm/instructions": 0.8,
  sexual: 0.8,
  "sexual/minors": 0.3,
  violence: 0.9,
  "violence/graphic": 0.9,
};

// Sentinels for images that never got a verdict. Each one blocks a full-coverage caller, but
// they differ in the reason the seller sees, so they are kept apart.
export const UNREACHED = Symbol("unreached");
export const UNSUPPORTED = Symbol("unsupported");
export const UNFETCHABLE = Symbol("unfetchable");

export type ImageVerdict = CategoryScores | null | typeof UNREACHED | typeof UNSUPPORTED | typeof UNFETCHABLE;

const PERMANENT_REJECTION_CODES: ReadonlySet<string> = new Set(["invalid_data_url", "invalid_image_format", "file_too_large"]);
const UNFETCHABLE_ERROR_CODE = "image_url_unavailable";
const TRANSIENT_KINDS: ReadonlySet<OpenAiRequestErrorKind> = new Set(["timeout", "connection", "parsing", "server"]);

// Ruby's Float#round(3).to_s, the only float formatting the reasons need. Ruby switches to
// exponent notation below 1e-4 and at 1e16 and above, and always prints one fraction digit.
export function rubyFloatToS(value: number): string {
  if (value === 0) return "0.0";
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    const [mantissa, exponent] = value.toExponential().split("e");
    const digits = mantissa!.includes(".") ? mantissa! : `${mantissa}.0`;
    const sign = exponent!.startsWith("-") ? "-" : "+";
    const magnitudeDigits = exponent!.replace(/^[-+]/u, "").padStart(2, "0");
    return `${digits}e${sign}${magnitudeDigits}`;
  }
  const plain = String(value);
  return plain.includes(".") ? plain : `${plain}.0`;
}

export function loadThresholds(customJson: string | null | undefined): Record<string, number> {
  if (customJson == null || customJson.trim() === "") return { ...DEFAULT_THRESHOLDS };
  try {
    const parsed: unknown = JSON.parse(customJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_THRESHOLDS };
    return { ...DEFAULT_THRESHOLDS, ...(parsed as Record<string, number>) };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function collectFlagged(scores: CategoryScores, thresholds: Readonly<Record<string, number>>): string[] {
  const flagged: string[] = [];
  for (const [category, score] of Object.entries(scores)) {
    const threshold = thresholds[category];
    if (threshold === undefined || !(score >= threshold)) continue;
    flagged.push(`${category} (score: ${rubyFloatToS(roundTo3(score))}, threshold: ${rubyFloatToS(threshold)})`);
  }
  return flagged;
}

// Approximates Float#round(3). The two can differ on exact binary ties, which OpenAI's scores
// do not produce in practice.
function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class ClassifierStrategy {
  private readonly api: ModerationApi;
  private readonly apiKey: string | null;
  private readonly thresholds: Readonly<Record<string, number>>;
  private readonly secretKeyBase: string;
  private readonly s3BaseUrl: string;
  private readonly now: () => number;
  private readonly notify: (error: unknown, context: Record<string, unknown>) => void;

  constructor(options: ClassifierOptions) {
    this.api = options.api;
    this.apiKey = options.apiKey;
    this.thresholds = options.thresholds;
    this.secretKeyBase = options.secretKeyBase;
    this.s3BaseUrl = options.s3BaseUrl;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.notify = options.notify ?? (() => {});
  }

  async perform(input: ClassifierInput): Promise<ClassifierResult> {
    const text = input.text;
    const imageUrls = input.imageUrls ?? [];
    const maxImages = input.maxImages ?? MAX_IMAGES_TO_MODERATE;
    const imageUrlsAreStored = input.imageUrlsAreStored ?? false;

    if (isBlank(text) && imageUrls.length === 0) return compliant();
    if (isBlank(this.apiKey)) return compliant();

    const flagged: string[] = [];
    let textModerated = false;

    if (!isBlank(text)) {
      const scores = await this.moderate([{ type: "text", text }], { timeoutSeconds: OPENAI_REQUEST_TIMEOUT_IN_SECONDS });
      if (scores === null || typeof scores !== "object") return { status: "flagged", reasoning: [UNAVAILABLE_REASON] };
      textModerated = true;
      flagged.push(...collectFlagged(scores as CategoryScores, this.thresholds));
    }

    let moderatedCount = 0;
    const skipped: string[] = [];
    const unreached: string[] = [];
    const unfetchable: string[] = [];
    const unsupported: string[] = [];

    const urlsToModerate = orderedImageUrls(imageUrls, this.secretKeyBase);
    const deadline = this.now() + IMAGE_PHASE_DEADLINE_IN_SECONDS;
    const phase: ImagePhase = { deadline, imageUrlsAreStored };

    for (let offset = 0; offset < urlsToModerate.length; offset += IMAGES_PER_REQUEST) {
      const batch = urlsToModerate.slice(offset, offset + IMAGES_PER_REQUEST);
      const remaining = maxImages === "all" ? batch.length : maxImages - moderatedCount;
      if (remaining <= 0) break;

      const selected = batch.slice(0, remaining);
      if (this.deadlineExpired(phase)) {
        unreached.push(...selected);
        continue;
      }

      for (const [url, verdict] of await this.moderateImages(selected, phase)) {
        if (verdict === UNREACHED) {
          unreached.push(url);
        } else if (verdict === UNFETCHABLE) {
          unfetchable.push(url);
        } else if (verdict === UNSUPPORTED) {
          unsupported.push(url);
        } else if (verdict === null) {
          skipped.push(url);
        } else {
          moderatedCount += 1;
          flagged.push(...collectFlagged(verdict, this.thresholds));
        }
      }
    }

    // A concrete violation is more actionable than "try again later", so a real flag wins.
    if (flagged.length > 0) {
      return {
        status: "flagged",
        reasoning: [...new Set(flagged)].map((category) => `OpenAI moderation flagged: ${category}`),
      };
    }

    // Full coverage (`:all`) blocks on any image it could not review, so a page cannot publish
    // an image that only browsers were allowed to see.
    if (maxImages === "all" && (skipped.length || unreached.length || unfetchable.length || unsupported.length)) {
      return { status: "flagged", reasoning: [blockingReason({ skipped, unreached, unfetchable, unsupported })] };
    }

    if (imageUrls.length > 0 && moderatedCount === 0) {
      if (!textModerated) {
        this.notify("ContentModeration::ClassifierStrategy could not moderate any image", {
          image_url_count: imageUrls.length,
          skipped_urls: [...skipped, ...unfetchable, ...unsupported].map(loggableUrl),
        });
        return { status: "flagged", reasoning: [blockingReason({ skipped, unreached, unfetchable, unsupported })] };
      }
      // Text was reviewed, so a text-only verdict stands. Images that OpenAI refused are expected.
    }

    return compliant();
  }

  private async moderateImages(urls: readonly string[], phase: ImagePhase): Promise<Array<[string, ImageVerdict]>> {
    const oversized = urls.filter((url) => isOversizedDataImage(url));
    const sendable = urls.filter((url) => !isOversizedDataImage(url));
    const refused: Array<[string, ImageVerdict]> = oversized.map((url) => [url, UNSUPPORTED]);

    if (sendable.length === 0) return refused;
    if (sendable.length === 1) return [...refused, ...(await this.individually(sendable, phase))];

    const scores = await this.moderateBatch(
      sendable.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      phase,
    );
    if (scores !== null) {
      return [...refused, ...sendable.map((url, index): [string, ImageVerdict] => [url, scores[index] ?? null])];
    }
    return [...refused, ...(await this.individually(sendable, phase))];
  }

  private async individually(urls: readonly string[], phase: ImagePhase): Promise<Array<[string, ImageVerdict]>> {
    const results: Array<[string, ImageVerdict]> = [];
    for (const url of urls) {
      if (this.deadlineExpired(phase)) {
        results.push([url, UNREACHED]);
        continue;
      }
      results.push([url, await this.moderateOneImage(url, phase)]);
    }
    return results;
  }

  // Null when the batch failed as a whole, so the caller retries one image at a time.
  private async moderateBatch(
    input: ModerationInput[],
    phase: ImagePhase,
  ): Promise<Array<CategoryScores | null> | null> {
    let response: unknown;
    try {
      response = await this.request(input, IMAGE_BATCH_REQUEST_TIMEOUT_IN_SECONDS, phase);
    } catch (error) {
      if (error instanceof OpenAiRequestError) return null;
      throw error;
    }

    const results = (response as { results?: unknown } | null)?.results;
    // A short array would pair scores with the wrong URLs, which is worse than no verdict.
    if (!Array.isArray(results) || results.length !== input.length) return null;

    // A slot with no scores is an image without a verdict, not a clean one.
    return results.map((result) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
      const scores = (result as { category_scores?: unknown }).category_scores;
      return scores !== null && typeof scores === "object" && !Array.isArray(scores) ? (scores as CategoryScores) : null;
    });
  }

  private async moderateOneImage(url: string, phase: ImagePhase): Promise<ImageVerdict> {
    return this.moderate([{ type: "image_url", image_url: { url } }], {
      skipUrl: url,
      timeoutSeconds: OPENAI_REQUEST_TIMEOUT_IN_SECONDS,
      phase,
    });
  }

  // Single-input request with retries on transient failures. A bad-request answer for an image
  // is classified rather than thrown, so one bad image cannot abort the publish.
  private async moderate(
    input: ModerationInput[],
    options: { skipUrl?: string; timeoutSeconds?: number; phase?: ImagePhase },
  ): Promise<ImageVerdict> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const response = await this.request(input, options.timeoutSeconds, options.phase);
        const scores = (response as { results?: Array<{ category_scores?: unknown }> } | null)?.results?.[0]?.category_scores;
        if (scores === null || typeof scores !== "object" || Array.isArray(scores)) return null;
        return scores as CategoryScores;
      } catch (error) {
        if (!(error instanceof OpenAiRequestError)) throw error;

        if (TRANSIENT_KINDS.has(error.kind)) {
          const stoppedByDeadline = options.phase ? this.deadlineExpired(options.phase) : false;
          if (attempts < MAX_MODERATION_ATTEMPTS && !stoppedByDeadline) continue;
          this.notify(error, { attempts, input_type: input[0]?.type, skip_url: loggableUrl(options.skipUrl) });
          return null;
        }

        if (error.kind !== "bad_request" || options.skipUrl === undefined) throw error;

        const code = errorCode(error.body);
        // A stored or private-bucket URL is never fetchable by a later save, so its failure is final.
        if (code === UNFETCHABLE_ERROR_CODE && this.unfetchableUrl(options.skipUrl, options.phase)) return UNFETCHABLE;
        if (code !== null && PERMANENT_REJECTION_CODES.has(code)) return UNSUPPORTED;
        return null;
      }
    }
  }

  // Clamps the request to what is left of the image phase, so a late request cannot overrun it.
  private async request(
    input: ModerationInput[],
    timeoutSeconds: number | undefined,
    phase: ImagePhase | undefined,
  ): Promise<unknown> {
    let effective = timeoutSeconds ?? OPENAI_REQUEST_TIMEOUT_IN_SECONDS;
    if (timeoutSeconds !== undefined && phase) {
      const remaining = phase.deadline - this.now();
      if (remaining < timeoutSeconds) effective = Math.max(remaining, 0.001);
    }
    return this.api.moderations({ model: MODERATION_MODEL, input }, effective);
  }

  private deadlineExpired(phase: ImagePhase): boolean {
    return phase.deadline - this.now() <= 0;
  }

  private unfetchableUrl(url: string, phase: ImagePhase | undefined): boolean {
    return (phase?.imageUrlsAreStored ?? false) || url.startsWith(this.s3BaseUrl);
  }
}

type ImagePhase = { deadline: number; imageUrlsAreStored: boolean };

function compliant(): ClassifierResult {
  return { status: "compliant", reasoning: [] };
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function isOversizedDataImage(url: string): boolean {
  return url.startsWith("data:") && Buffer.byteLength(url, "utf8") > MAX_DATA_IMAGE_BYTES;
}

// A data: URL is the image itself, so only its prefix is logged.
function loggableUrl(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith("data:")) return url;
  return `${url.slice(0, 30)}…(${Buffer.byteLength(url, "utf8")} bytes inline)`;
}

function errorCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function blockingReason(lists: {
  skipped: readonly string[];
  unreached: readonly string[];
  unfetchable: readonly string[];
  unsupported: readonly string[];
}): string {
  // A transient cause outranks a permanent one, so the seller retries before fixing the image.
  if (lists.skipped.length > 0 || lists.unreached.length > 0) return UNAVAILABLE_REASON;
  if (lists.unfetchable.length > 0) return UNFETCHABLE_IMAGE_REASON;
  if (lists.unsupported.length > 0) return UNSUPPORTED_IMAGE_REASON;
  return UNAVAILABLE_REASON;
}
