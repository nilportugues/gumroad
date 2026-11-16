// Port of app/services/content_moderation/moderate_record_service.rb.
// The record and its user are read by the caller and passed in as a `ModerationSubject`. Database
// lookups that only a spam flag or a deliverable check needs are lazy thunks, so they run only
// when the Ruby code would run them. Admin notes go through the injected `enqueueAdminComment`.
import {
  type ClassifierResult,
  UNAVAILABLE_REASON,
  UNFETCHABLE_IMAGE_REASON,
  UNSUPPORTED_IMAGE_REASON,
} from "./classifier-strategy.ts";
import { performBlocklist } from "./blocklist-strategy.ts";
import { MAX_PAGE_IMAGE_URLS } from "./content-extractor.ts";
import type { PromptResult } from "./prompt-strategy.ts";
import { rubySplit } from "./ruby.ts";

export type EntityType = "product" | "post" | "page";

export type CheckResult = {
  passed: boolean;
  reasons: string[];
  // A spam flag still stood, and the seller has no product or sale behind the page or post.
  emptyStorefront: boolean;
};

export type ModerationContent = { text: string; imageUrls: string[] };

export type ModeratedUser = { id: string; verified: boolean } | null;

export type StoredFileFact = {
  id: number;
  // true or false when the row says whether the file is stored, null when only S3 can tell.
  presenceKnownFromRow: boolean | null;
  storedFilePresent: () => Promise<boolean>;
};

export type FileOwnerFacts = { aliveProductFiles: StoredFileFact[] };

export type ProductFacts = {
  nativeType: string;
  isPhysical: boolean;
  isBundle: boolean;
  hasAliveBundleProducts: () => Promise<boolean>;
  // Circle or Discord, which Gumroad provisions on purchase, active on the product or a variant.
  hasGumroadFulfilledCommunityIntegration: () => Promise<boolean>;
  hasAnyActiveIntegration: () => Promise<boolean>;
  product: FileOwnerFacts;
  variants: FileOwnerFacts[];
  hasReadableBodyContent: () => Promise<boolean>;
  hasReaderVisibleContent: () => Promise<boolean>;
};

// The subject of a check. `pageLabel` and `name` only appear in admin notes.
export type ModerationSubject = {
  entityType: EntityType;
  recordId: string;
  name?: string;
  pageLabel?: string;
  user: ModeratedUser;
  moderationPreview: boolean;
  // Already resolved for the entity type, including the account-level exemption for products.
  recordModerationDisabled: boolean;
  extractContent: () => Promise<ModerationContent>;
  previousPageImageUrls?: () => Promise<string[]>;
  skipImages: boolean;
  // Read only when a spam flag or the off-platform preset needs them.
  sellerHasStorefront?: () => Promise<boolean>;
  tipJarFromEstablishedSeller?: () => Promise<boolean>;
  product?: ProductFacts;
};

export type AiStrategyOptions = {
  classifier: { maxImages: number | "all"; imageUrlsAreStored: boolean };
  checkOffPlatformFulfillment: boolean;
};

export type ModerationDeps = {
  moderationEnabled: boolean;
  blocklistWords: readonly string[];
  // Runs ClassifierStrategy and PromptStrategy concurrently and returns both verdicts.
  runAiStrategies: (
    content: ModerationContent,
    options: AiStrategyOptions,
  ) => Promise<{ classifier: ClassifierResult; prompt: PromptResult }>;
  // Enqueues ContentModerationAdminCommentJob with (user id, note).
  enqueueAdminComment: (userId: string, content: string) => Promise<unknown>;
  // Monotonic seconds, for the storage check budget.
  now?: () => number;
  notify?: (error: unknown) => void;
};

export const STORAGE_CHECK_TIME_BUDGET_SECONDS = 2.0;

export const TOO_MANY_IMAGES_REASON_PREFIX = "too many images to review";

const NATIVE_TYPE_COFFEE = "coffee";
const NATIVE_TYPE_CALL = "call";
const NATIVE_TYPE_COMMISSION = "commission";
const SERVICE_TYPES: readonly string[] = [NATIVE_TYPE_COMMISSION, NATIVE_TYPE_CALL, NATIVE_TYPE_COFFEE];

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  harassment: "harassment",
  "harassment/threatening": "threatening harassment",
  hate: "hateful content",
  "hate/threatening": "threatening hateful content",
  illicit: "illicit content",
  "illicit/violent": "instructions for violence",
  "self-harm": "self-harm content",
  "self-harm/intent": "self-harm content",
  "self-harm/instructions": "self-harm content",
  sexual: "sexual content",
  "sexual/minors": "sexual content involving minors",
  violence: "violent content",
  "violence/graphic": "graphic violence",
};

export const PROMPT_PRESET_LABELS: Readonly<Record<string, string>> = {
  spam: "content that reads as promotional spam",
  adult_content: "adult content",
  off_platform_fulfillment: "off-platform fulfillment",
};

export const OFF_PLATFORM_FULFILLMENT_MESSAGE =
  "Buyers need to receive what they paid for on Gumroad. This %<noun>s has no content attached and " +
  "directs buyers to message you on another platform to get it, which we don’t allow. Add the files, " +
  "videos, or written content buyers should get when they buy, then publish again.";

const GENERIC_REASON = "something that may violate our content guidelines";

// Turns raw reasons into a phrase the seller can act on, without scores, thresholds or the provider.
export function humanizeReasons(reasons: readonly string[]): string {
  const labels: string[] = [];
  for (const reason of reasons) {
    const preset = (rubySplit(reason, ":")[0] ?? "").trim().toLowerCase();
    if (Object.hasOwn(PROMPT_PRESET_LABELS, preset)) {
      labels.push(PROMPT_PRESET_LABELS[preset]!);
      continue;
    }
    const beforeParenthesis = rubySplit(reason, " (")[0] ?? "";
    const key = (rubySplit(beforeParenthesis, ": ").at(-1) ?? "").trim().toLowerCase();
    if (Object.hasOwn(CATEGORY_LABELS, key)) labels.push(CATEGORY_LABELS[key]!);
  }
  const unique = [...new Set(labels)];
  return unique.length === 0 ? GENERIC_REASON : toSentence(unique);
}

// The seller-facing message for a blocked record. `noun` is "product", "post" or "page".
export function sellerMessage(
  reasons: readonly string[],
  noun: string,
  options: { title?: string | null; emptyStorefront?: boolean } = {},
): string {
  const transient = UNAVAILABLE_REASON;
  const unsupported = UNSUPPORTED_IMAGE_REASON;
  const unfetchable = UNFETCHABLE_IMAGE_REASON;

  if (reasons.length > 0 && reasons.every((r) => r.includes(transient))) {
    return `We couldn’t review this ${noun} just now (a temporary issue on our end). Please try again in a few minutes.`;
  }
  if (reasons.length > 0 && reasons.every((r) => r.includes(unsupported))) {
    return (
      `This ${noun} includes an image we can’t review, because the format is unsupported (such as an SVG data URL) ` +
      "or the file is too large. Replace it with a smaller PNG, JPEG, GIF, or WebP and try again."
    );
  }
  if (reasons.length > 0 && reasons.every((r) => r.includes(unfetchable))) {
    return (
      `This ${noun} includes an image we couldn’t download from its link, so we couldn’t review it. ` +
      "Replace that image with a new upload and save again."
    );
  }
  if (reasons.some((r) => r.startsWith(TOO_MANY_IMAGES_REASON_PREFIX))) {
    return (
      `This ${noun} has more images than we can review, so we can’t publish it as is. ` +
      `Reduce it to at most ${MAX_PAGE_IMAGE_URLS} images (or split it across several ${noun}s) and try again.`
    );
  }
  if (reasons.some(isOffPlatformFulfillmentReason)) {
    const message = OFF_PLATFORM_FULFILLMENT_MESSAGE.replace("%<noun>s", noun);
    const others = reasons.filter((r) => !isOffPlatformFulfillmentReason(r));
    return others.length > 0
      ? `${message} It also looks like this ${noun} contains ${humanizeReasons(others)}.`
      : message;
  }

  const title = options.title ?? null;
  if (options.emptyStorefront && reasons.some((r) => r.startsWith("spam:"))) {
    const subject = title !== null && title.trim() !== "" ? `The ${noun} "${title}"` : `This ${noun}`;
    const message =
      `${subject} can’t be saved yet. It reads as promotional, and your account doesn’t have a published product ` +
      `or a sale yet, so we can’t publish promotional ${noun}s for it. Publish a product first, then save this ${noun} again.`;
    const others = reasons.filter((r) => !r.startsWith("spam:"));
    return others.length > 0 ? `${message} ${sellerMessage(others, noun)}` : message;
  }

  const subject = title !== null && title.trim() !== "" ? `The ${noun} "${title}"` : `This ${noun}`;
  return (
    `${subject} can’t be saved because it looks like it contains ${humanizeReasons(reasons)}. ` +
    "Please update the content to follow our content guidelines."
  );
}

function isOffPlatformFulfillmentReason(reason: string): boolean {
  return reason.startsWith("off_platform_fulfillment:");
}

function isSpamReason(reason: string): boolean {
  return reason.startsWith("spam:");
}

// Tracks which files a save has looked up, so an exhausted budget can report what it never checked.
export class StorageCheckBudget {
  private readonly deadline: number;
  private readonly checked = new Set<number>();
  private readonly skipped = new Set<number>();

  constructor(
    seconds: number,
    private readonly now: () => number,
  ) {
    this.deadline = now() + seconds;
  }

  spent(): boolean {
    return this.now() >= this.deadline;
  }

  recordChecked(file: StoredFileFact): void {
    this.checked.add(file.id);
  }

  recordSkipped(files: readonly StoredFileFact[]): void {
    for (const file of files) this.skipped.add(file.id);
  }

  uncheckedFileCount(): number {
    let count = 0;
    for (const id of this.skipped) if (!this.checked.has(id)) count += 1;
    return count;
  }
}

export async function checkRecordModeration(
  deps: ModerationDeps,
  subject: ModerationSubject,
): Promise<CheckResult> {
  const passed: CheckResult = { passed: true, reasons: [], emptyStorefront: false };
  if (!deps.moderationEnabled) return passed;
  if (subject.user?.verified) return passed;
  if (subject.recordModerationDisabled) return passed;

  let content = await subject.extractContent();
  if (subject.skipImages) content = { text: content.text, imageUrls: [] };
  if (isBlank(content.text) && content.imageUrls.length === 0) return passed;

  if (subject.entityType === "page" && content.imageUrls.length > MAX_PAGE_IMAGE_URLS) {
    const previous = (await subject.previousPageImageUrls?.()) ?? [];
    if (previous.length > MAX_PAGE_IMAGE_URLS && content.imageUrls.length <= previous.length) {
      // A live over-budget page may still be edited, as long as it does not gain images.
      content = { text: content.text, imageUrls: content.imageUrls.filter((url) => !previous.includes(url)) };
    } else {
      const reasons = [`${TOO_MANY_IMAGES_REASON_PREFIX} (${content.imageUrls.length})`];
      await leaveAdminComment(deps, subject, reasons, false);
      return { passed: false, reasons, emptyStorefront: false };
    }
  }

  const blocklist = performBlocklist(content.text, deps.blocklistWords);
  if (blocklist.status === "flagged") {
    await leaveAdminComment(deps, subject, blocklist.reasoning, true);
    return { passed: false, reasons: blocklist.reasoning, emptyStorefront: false };
  }

  const checkOffPlatform = subject.entityType === "product" && subject.product !== undefined
    ? !(await productHasDeliverable(subject.product))
    : false;
  const isPageOrPost = subject.entityType === "page" || subject.entityType === "post";
  const ai = await deps.runAiStrategies(content, {
    classifier: {
      maxImages: subject.entityType === "page" ? "all" : 5,
      imageUrlsAreStored: isPageOrPost,
    },
    checkOffPlatformFulfillment: checkOffPlatform,
  });

  const flagged = [ai.classifier, ai.prompt].filter((result) => result.status === "flagged");
  let auditReasons = ai.prompt.auditReasoning;
  let reasons = flagged.flatMap((result) => result.reasoning);

  // Read only when there is a spam flag to downgrade, since it can spend the storage budget.
  if (reasons.some(isSpamReason) && (await spamFlagShouldNotBlock(subject, deps))) {
    const downgraded = reasons.filter(isSpamReason);
    reasons = reasons.filter((r) => !isSpamReason(r));
    const note = spamDowngradeNoteReason(subject);
    auditReasons = [...auditReasons, ...downgraded.map((r) => `${r} (${note})`)];
  }

  if (auditReasons.length > 0) await leaveAdminComment(deps, subject, auditReasons, false);

  if (reasons.length > 0) {
    await leaveAdminComment(deps, subject, reasons, true);
    const emptyStorefront = isPageOrPost && reasons.some(isSpamReason);
    return { passed: false, reasons, emptyStorefront };
  }
  return passed;
}

// Spam keys on a listing's style. A listing that delivers something publishes with a note, and a
// page or post is judged by the seller's storefront instead.
async function spamFlagShouldNotBlock(subject: ModerationSubject, deps: ModerationDeps): Promise<boolean> {
  if (subject.entityType === "page" || subject.entityType === "post") return sellerHasStorefront(subject);
  if (subject.entityType !== "product" || subject.product === undefined) return false;

  if (subject.product.nativeType === NATIVE_TYPE_COFFEE) {
    if (subject.user === null) return false;
    return (await subject.tipJarFromEstablishedSeller?.()) ?? false;
  }
  return productHasSubstantiveDeliverable(subject.product, deps.now ?? (() => performance.now() / 1000));
}

async function sellerHasStorefront(subject: ModerationSubject): Promise<boolean> {
  if (subject.user === null) return false;
  return (await subject.sellerHasStorefront?.()) ?? false;
}

function spamDowngradeNoteReason(subject: ModerationSubject): string {
  if (subject.entityType === "page" || subject.entityType === "post" || subject.product?.nativeType === NATIVE_TYPE_COFFEE) {
    return "not blocked: seller has a live storefront";
  }
  return "not blocked: listing has content attached";
}

// Whether the buyer receives something for their money. Physical and bundle products, service
// types, and Gumroad-managed integrations all count without any content.
export async function productHasDeliverable(product: ProductFacts): Promise<boolean> {
  if (product.isPhysical || product.isBundle) return true;
  if (SERVICE_TYPES.includes(product.nativeType)) return true;
  if (await product.hasAnyActiveIntegration()) return true;
  if (product.product.aliveProductFiles.length > 0) return true;
  if (product.variants.some((variant) => variant.aliveProductFiles.length > 0)) return true;
  return product.hasReaderVisibleContent();
}

// Stricter than productHasDeliverable: a file only counts when storage confirms it, within a
// time budget shared by the product and its variants.
export async function productHasSubstantiveDeliverable(
  product: ProductFacts,
  now: () => number,
): Promise<boolean> {
  if (product.isPhysical) return true;
  if (product.isBundle && (await product.hasAliveBundleProducts())) return true;
  if (product.nativeType === NATIVE_TYPE_CALL || product.nativeType === NATIVE_TYPE_COMMISSION) return true;
  if (await product.hasGumroadFulfilledCommunityIntegration()) return true;

  const budget = new StorageCheckBudget(STORAGE_CHECK_TIME_BUDGET_SECONDS, now);
  const foundFile =
    (await hasDeliverableFile(product.product, budget)) ||
    (await anyAsync(product.variants, (variant) => hasDeliverableFile(variant, budget)));

  // Checked after the content so a product that ran out of file budget but passed on content does
  // not count as a failure.
  return foundFile || (await product.hasReadableBodyContent());
}

// An alive file row is not proof the object is stored. Newest files are checked first, and an
// exhausted budget fails on purpose: "we don't know" must not pass.
async function hasDeliverableFile(owner: FileOwnerFacts, budget: StorageCheckBudget): Promise<boolean> {
  const unverifiable: StoredFileFact[] = [];
  for (const file of owner.aliveProductFiles) {
    if (file.presenceKnownFromRow === true) return true;
    if (file.presenceKnownFromRow === null) unverifiable.push(file);
  }

  const newestFirst = [...unverifiable].sort((a, b) => b.id - a.id);
  for (let checked = 0; checked < newestFirst.length; checked += 1) {
    if (budget.spent()) {
      budget.recordSkipped(newestFirst.slice(checked));
      break;
    }
    const file = newestFirst[checked]!;
    budget.recordChecked(file);
    if (await file.storedFilePresent()) return true;
  }
  return false;
}

async function anyAsync<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) {
    if (await predicate(item)) return true;
  }
  return false;
}

async function leaveAdminComment(
  deps: ModerationDeps,
  subject: ModerationSubject,
  reasons: readonly string[],
  blocked: boolean,
): Promise<void> {
  if (subject.user === null) return;
  // A dry-run preview validates a candidate that never publishes, so it must leave no history.
  if (subject.moderationPreview) return;

  const label = adminLabel(subject);
  const action = blocked ? "blocked publish of" : "flagged but did not block";
  const content = `Content moderation ${action} ${label}: ${reasons.join("; ")}`;
  try {
    await deps.enqueueAdminComment(subject.user.id, content);
  } catch (error) {
    deps.notify?.(error);
  }
}

function adminLabel(subject: ModerationSubject): string {
  switch (subject.entityType) {
    case "product":
      return `Product #${subject.recordId} (${subject.name ?? ""})`;
    case "post":
      return `Post #${subject.recordId} (${subject.name ?? ""})`;
    case "page":
      return `Page #${subject.recordId} (${subject.pageLabel ?? ""})`;
  }
}

// Ruby's Array#to_sentence with the default English connectors.
function toSentence(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

