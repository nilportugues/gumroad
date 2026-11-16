import { describe, expect, it } from "vitest";

import type { ClassifierResult } from "./classifier-strategy.ts";
import { UNAVAILABLE_REASON } from "./classifier-strategy.ts";
import {
  checkRecordModeration,
  humanizeReasons,
  type ModerationDeps,
  type ModerationSubject,
  type ProductFacts,
  sellerMessage,
  StorageCheckBudget,
  type StoredFileFact,
} from "./moderate-record-service.ts";
import type { PromptResult } from "./prompt-strategy.ts";

const NO_FLAG_CLASSIFIER: ClassifierResult = { status: "compliant", reasoning: [] };
const NO_FLAG_PROMPT: PromptResult = { status: "compliant", reasoning: [], auditReasoning: [] };

function deps(overrides: Partial<ModerationDeps> & { enqueued?: Array<[string, string]> } = {}) {
  const enqueued: Array<[string, string]> = overrides.enqueued ?? [];
  const runs: unknown[] = [];
  const built: ModerationDeps = {
    moderationEnabled: true,
    blocklistWords: [],
    runAiStrategies: async (_content, options) => {
      runs.push(options);
      return { classifier: NO_FLAG_CLASSIFIER, prompt: NO_FLAG_PROMPT };
    },
    enqueueAdminComment: async (userId, content) => {
      enqueued.push([userId, content]);
    },
    now: () => 0,
    ...overrides,
  };
  return { deps: built, enqueued, runs };
}

function product(overrides: Partial<ModerationSubject> = {}): ModerationSubject {
  return {
    entityType: "product",
    recordId: "1",
    name: "Name",
    user: { id: "7", verified: false },
    moderationPreview: false,
    recordModerationDisabled: false,
    extractContent: async () => ({ text: "listing text", imageUrls: [] }),
    skipImages: false,
    ...overrides,
  };
}

function file(id: number, presenceKnownFromRow: boolean | null, stored = true): StoredFileFact {
  return { id, presenceKnownFromRow, storedFilePresent: async () => stored };
}

function productFacts(files: StoredFileFact[], overrides: Partial<ProductFacts> = {}): ProductFacts {
  return {
    nativeType: "digital",
    isPhysical: false,
    isBundle: false,
    hasAliveBundleProducts: async () => false,
    hasGumroadFulfilledCommunityIntegration: async () => false,
    hasAnyActiveIntegration: async () => false,
    product: { aliveProductFiles: files },
    variants: [],
    hasReadableBodyContent: async () => false,
    hasReaderVisibleContent: async () => false,
    ...overrides,
  };
}

describe("checkRecordModeration early exits", () => {
  it("passes without running any strategy when moderation is switched off", async () => {
    const { deps: d, runs } = deps({ moderationEnabled: false });
    expect(await checkRecordModeration(d, product())).toEqual({ passed: true, reasons: [], emptyStorefront: false });
    expect(runs).toEqual([]);
  });

  it("passes for a verified seller without running any strategy", async () => {
    const { deps: d, runs } = deps();
    const result = await checkRecordModeration(d, product({ user: { id: "7", verified: true } }));
    expect(result.passed).toBe(true);
    expect(runs).toEqual([]);
  });

  it("passes when the record carries the moderation exemption", async () => {
    const { deps: d, runs } = deps();
    expect((await checkRecordModeration(d, product({ recordModerationDisabled: true }))).passed).toBe(true);
    expect(runs).toEqual([]);
  });
});

describe("checkRecordModeration blocklist and AI verdicts", () => {
  it("blocks a blocklisted word and leaves a blocked admin note", async () => {
    const { deps: d, enqueued } = deps({ blocklistWords: ["casino"] });
    const result = await checkRecordModeration(d, product({ extractContent: async () => ({ text: "Casino!", imageUrls: [] }) }));

    expect(result).toEqual({ passed: false, reasons: ["Matched blocked word: casino"], emptyStorefront: false });
    expect(enqueued).toEqual([["7", "Content moderation blocked publish of Product #1 (Name): Matched blocked word: casino"]]);
  });

  it("publishes a spam flag on a product with a stored file and leaves a non-blocking note", async () => {
    const { deps: d, enqueued } = deps({
      runAiStrategies: async () => ({
        classifier: NO_FLAG_CLASSIFIER,
        prompt: { status: "flagged", reasoning: ["spam: repetitive"], auditReasoning: [] },
      }),
    });
    const result = await checkRecordModeration(
      d,
      product({ product: productFacts([file(5, true)]) }),
    );

    expect(result.passed).toBe(true);
    expect(enqueued).toEqual([
      ["7", "Content moderation flagged but did not block Product #1 (Name): spam: repetitive (not blocked: listing has content attached)"],
    ]);
  });

  it("blocks a spam flag on a product whose only file is not stored, and reports no empty storefront", async () => {
    const { deps: d } = deps({
      runAiStrategies: async () => ({
        classifier: NO_FLAG_CLASSIFIER,
        prompt: { status: "flagged", reasoning: ["spam: repetitive"], auditReasoning: [] },
      }),
    });
    const result = await checkRecordModeration(d, product({ product: productFacts([file(5, false)]) }));

    expect(result).toEqual({ passed: false, reasons: ["spam: repetitive"], emptyStorefront: false });
  });

  it("blocks a spam flag on a post whose seller has no storefront and marks the empty storefront", async () => {
    const { deps: d } = deps({
      runAiStrategies: async () => ({
        classifier: NO_FLAG_CLASSIFIER,
        prompt: { status: "flagged", reasoning: ["spam: link farm"], auditReasoning: [] },
      }),
    });
    const result = await checkRecordModeration(
      d,
      product({ entityType: "post", sellerHasStorefront: async () => false }),
    );

    expect(result).toEqual({ passed: false, reasons: ["spam: link farm"], emptyStorefront: true });
  });

  it("keeps a spam flag as a note for a post from a seller with a live storefront", async () => {
    const { deps: d } = deps({
      runAiStrategies: async () => ({
        classifier: NO_FLAG_CLASSIFIER,
        prompt: { status: "flagged", reasoning: ["spam: newsletter"], auditReasoning: [] },
      }),
    });
    const result = await checkRecordModeration(
      d,
      product({ entityType: "post", sellerHasStorefront: async () => true }),
    );
    expect(result.passed).toBe(true);
  });

  it("reads the seller storefront only when a spam flag needs it", async () => {
    let storefrontReads = 0;
    const { deps: d } = deps();
    await checkRecordModeration(
      d,
      product({
        entityType: "post",
        sellerHasStorefront: async () => {
          storefrontReads += 1;
          return true;
        },
      }),
    );
    expect(storefrontReads).toBe(0);
  });

  it("leaves no admin note for a dry-run preview, which was never published", async () => {
    const { deps: d, enqueued } = deps({ blocklistWords: ["casino"] });
    const result = await checkRecordModeration(
      d,
      product({ moderationPreview: true, extractContent: async () => ({ text: "casino", imageUrls: [] }) }),
    );
    expect(result.passed).toBe(false);
    expect(enqueued).toEqual([]);
  });

  it("moderates every image of a page with full coverage and stored URLs", async () => {
    const { deps: d, runs } = deps();
    await checkRecordModeration(
      d,
      product({
        entityType: "page",
        recordId: "9",
        pageLabel: "profile page",
        extractContent: async () => ({ text: "page", imageUrls: ["https://cdn.example.com/a.png"] }),
      }),
    );
    expect(runs).toEqual([{ classifier: { maxImages: "all", imageUrlsAreStored: true }, checkOffPlatformFulfillment: false }]);
  });

  it("blocks a page over the image budget and says so in the seller message", async () => {
    const images = Array.from({ length: 26 }, (_, n) => `https://cdn.example.com/${n}.png`);
    const { deps: d, enqueued } = deps();
    const result = await checkRecordModeration(
      d,
      product({
        entityType: "page",
        recordId: "9",
        pageLabel: "profile page",
        extractContent: async () => ({ text: "page", imageUrls: images }),
      }),
    );

    expect(result).toEqual({ passed: false, reasons: ["too many images to review (26)"], emptyStorefront: false });
    expect(enqueued[0]?.[1]).toBe(
      "Content moderation flagged but did not block Page #9 (profile page): too many images to review (26)",
    );
    expect(sellerMessage(result.reasons, "page")).toBe(
      "This page has more images than we can review, so we can’t publish it as is. Reduce it to at most 25 images (or split it across several pages) and try again.",
    );
  });
});

describe("humanizeReasons and sellerMessage", () => {
  it("names preset and category reasons without scores or thresholds", () => {
    expect(
      humanizeReasons(["spam: repetitive", "OpenAI moderation flagged: violence (score: 0.86, threshold: 0.9)"]),
    ).toBe("content that reads as promotional spam and violent content");
  });

  it("falls back to a generic phrase for an unknown reason", () => {
    expect(humanizeReasons(["mystery"])).toBe("something that may violate our content guidelines");
  });

  it("describes a transient outage as something to retry", () => {
    expect(sellerMessage([UNAVAILABLE_REASON], "product")).toBe(
      "We couldn’t review this product just now (a temporary issue on our end). Please try again in a few minutes.",
    );
  });

  it("names the record in a content block", () => {
    expect(sellerMessage(["OpenAI moderation flagged: sexual/minors (score: 0.5, threshold: 0.3)"], "product", { title: "Pack" })).toBe(
      "The product \"Pack\" can’t be saved because it looks like it contains sexual content involving minors. Please update the content to follow our content guidelines.",
    );
  });
});

describe("StorageCheckBudget", () => {
  it("reports the files it never looked up, excluding any an earlier list already checked", () => {
    let clock = 0;
    const budget = new StorageCheckBudget(2, () => clock);
    const a = file(1, null);
    const b = file(2, null);
    budget.recordChecked(a);
    budget.recordSkipped([a, b]);

    expect(budget.uncheckedFileCount()).toBe(1);
    clock = 2;
    expect(budget.spent()).toBe(true);
  });
});

describe("product deliverable checks", () => {
  it("publishes a spam-flagged product whose unconfirmed file is backed by readable content", async () => {
    const { deps: d } = deps({
      runAiStrategies: async () => ({
        classifier: NO_FLAG_CLASSIFIER,
        prompt: { status: "flagged", reasoning: ["spam: repetitive"], auditReasoning: [] },
      }),
    });
    const result = await checkRecordModeration(
      d,
      product({ product: productFacts([file(1, null, false)], { hasReadableBodyContent: async () => true }) }),
    );
    expect(result.passed).toBe(true);
  });

  it("asks the off-platform preset only for a product with nothing deliverable", async () => {
    const { deps: d, runs } = deps();
    await checkRecordModeration(d, product({ product: productFacts([]) }));
    await checkRecordModeration(d, product({ product: productFacts([file(2, true)]) }));

    expect(runs).toEqual([
      { classifier: { maxImages: 5, imageUrlsAreStored: false }, checkOffPlatformFulfillment: true },
      { classifier: { maxImages: 5, imageUrlsAreStored: false }, checkOffPlatformFulfillment: false },
    ]);
  });
});
