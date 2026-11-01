// User#avatar_url (app/models/user.rb) for an uploaded avatar: the 400x400 variant's public URL, read
// through the same Rails.cache entries Rails writes, then rewritten to the CDN host.
import type { User } from "@prisma/client";

import { RubySymbol, type MarshalValue } from "../../cache/marshal.ts";
import { railsCache } from "../../cache/rails-cache.ts";
import { isConfiguredService, isVariable, publicStorageExists, publicStorageUrl, resizeToLimitDigest } from "../../infra/active-storage.ts";
import { cdnUrlFor } from "../../infra/cdn-url.ts";
import { notifyError } from "../../infra/error-reporting.ts";
import { NotPortedError } from "../not-ported.ts";
import { avatarAttachmentOf, blobById, variantBlobKey, variantRecordId, type BlobRow } from "./reads.ts";

// User#avatar_variant: "so avatars stay sharp on Retina/high-DPI screens".
const AVATAR_VARIANT_LIMIT = 400;
const DAY_SECONDS = 24 * 60 * 60;
const AVATAR_VARIANT_URL_CACHE_TTL = DAY_SECONDS;
const AVATAR_VARIANT_PRESENCE_CACHE_TTL = 5 * 60;

class InvariableError extends Error {}

function hashGet(hash: MarshalValue | undefined, name: string): MarshalValue | undefined {
  if (!(hash instanceof Map)) return undefined;
  for (const [key, value] of hash) if (key instanceof RubySymbol && key.name === name) return value;
  return undefined;
}

const presentString = (value: MarshalValue | undefined): value is string => typeof value === "string" && value.trim() !== "";

// User#avatar_variant_file_present?: a lookup that itself fails is not evidence the file is gone.
async function variantFilePresent(key: string | null, verifyStorage: boolean): Promise<boolean> {
  if (key === null || key.trim() === "") return true;
  const cache = railsCache();
  const cacheKey = `active_storage_variant_present_${key}`;
  try {
    if (!verifyStorage && (await cache.read(cacheKey))) return true;
    if (!(await publicStorageExists(key))) {
      await cache.delete(cacheKey);
      return false;
    }
    await cache.write(cacheKey, true, { expiresIn: AVATAR_VARIANT_PRESENCE_CACHE_TTL });
    return true;
  } catch (error) {
    notifyError(error);
    return true;
  }
}

// The variant Rails would serve, whose file must exist. A variant Rails has not processed yet, or
// whose file has vanished, is made by ImageMagick, which Rails keeps.
async function processedVariantKey(blob: BlobRow): Promise<string | null> {
  if (!isVariable(blob.content_type)) throw new InvariableError(`Can't transform blob with ID=${blob.id} and content_type=${blob.content_type}`);
  const digest = resizeToLimitDigest(blob.content_type!, blob.filename, AVATAR_VARIANT_LIMIT);
  const recordId = await variantRecordId(blob.id, digest);
  if (recordId === null) throw new NotPortedError("Generating an avatar variant");
  const key = await variantBlobKey(recordId);
  if (!(await variantFilePresent(key, true))) throw new NotPortedError("Regenerating a vanished avatar variant");
  return key;
}

// User#cached_avatar_variant_url
async function cachedAvatarVariantUrl(attachmentId: bigint, blob: BlobRow): Promise<string | null> {
  const cache = railsCache();
  const cacheKey = `attachment_${attachmentId}_variant_url_v3`;
  const cached = await cache.read(cacheKey);
  const cachedUrl = hashGet(cached, "url");
  const cachedKey = hashGet(cached, "key");
  if (presentString(cachedUrl) && presentString(cachedKey) && (await variantFilePresent(cachedKey, false))) return cachedUrl;

  const key = await processedVariantKey(blob);
  const url = key === null ? null : publicStorageUrl(key);
  if (url !== null && key !== null && key.trim() !== "") {
    await cache.write(cacheKey, new Map<MarshalValue, MarshalValue>([[new RubySymbol("url"), url], [new RubySymbol("key"), key]]), { expiresIn: AVATAR_VARIANT_URL_CACHE_TTL });
  }
  return url;
}

// User#avatar_url for a user whose avatar is attached. Anything Rails would rescue falls back to the
// uploaded file's own URL, as it does (without the CDN rewrite); what only Rails can do (processing
// an image) throws.
export async function uploadedAvatarUrl(user: Pick<User, "id">): Promise<string | null> {
  const attachment = await avatarAttachmentOf(user.id);
  if (attachment === null) return null;
  const blob = await blobById(attachment.blob_id);
  if (blob === null) throw new NotPortedError("User#avatar_url for an attachment whose blob row is missing");
  if (!isConfiguredService(blob.service_name)) throw new NotPortedError(`Active Storage service ${JSON.stringify(blob.service_name)}`);
  try {
    const variantUrl = await cachedAvatarVariantUrl(attachment.id, blob);
    return variantUrl === null || variantUrl.trim() === "" ? publicStorageUrl(blob.key) : (cdnUrlFor(variantUrl) ?? null);
  } catch (error) {
    if (error instanceof NotPortedError) throw error;
    return publicStorageUrl(blob.key);
  }
}
