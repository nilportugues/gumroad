// Port of app/services/content_moderation/image_selection.rb.
// The order is keyed on secret_key_base, so the key is a required input; callers pass the Rails
// secret (Rails.application.secret_key_base) and never a guessable constant.
import { createHmac } from "node:crypto";

function digest(url: string, secretKeyBase: string): string {
  return createHmac("sha256", secretKeyBase).update(url, "utf8").digest("hex");
}

// Every URL, in the deterministic moderation order.
export function orderedImageUrls(urls: readonly string[], secretKeyBase: string): string[] {
  return urls
    .map((url) => ({ url, key: digest(url, secretKeyBase) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ url }) => url);
}

// The first `limit` URLs of that order, or all of them when they already fit.
export function boundedImageUrls(urls: readonly string[], limit: number, secretKeyBase: string): string[] {
  if (urls.length <= limit) return [...urls];
  return orderedImageUrls(urls, secretKeyBase).slice(0, limit);
}
