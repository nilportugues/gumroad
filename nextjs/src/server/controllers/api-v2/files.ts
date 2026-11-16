// Api::V2::FilesController (multipart upload to S3) and Api::V2::DirectUploadsController. Node answers every 400 they render before the
// first S3 call or blob insert; a request that passes them creates an upload id, a random guid or a blob key, so it goes to Rails whole.
import type { Params } from "../rails-body.ts";

import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, error400, registerApiV2 } from "./base.ts";
import { blank, blankParam, isHash, notPorted, rubyToI, rubyToS } from "./ruby-params.ts";

const BYTES_PER_GB = 1024n ** 3n;
const BYTES_PER_MB = 1024n ** 2n;
// Api::V2::FilesController::MAX_FILE_SIZE_GB and Api::V2::DirectUploadsController::MAX_FILE_SIZE_GB
const MAX_FILE_SIZE_GB = 20n;
const MAX_FILE_SIZE = MAX_FILE_SIZE_GB * BYTES_PER_GB;
// CreatePublicMediaService::MAX_IMAGE_BYTES
const MEDIA_MAX_IMAGE_SIZE = 10n * BYTES_PER_MB;
// CreatePublicMediaService::DISALLOWED_CONTENT_TYPES
const MEDIA_DISALLOWED_CONTENT_TYPES = ["image/svg+xml"];
const ALLOWED_CONTENT_TYPES = /^(?:image\/(?:jpeg|jpg|png|gif)|video\/[a-z0-9.+-]+)$/iu;
const MEDIA_ALLOWED_CONTENT_TYPES = /^image\/[a-z0-9.+-]+$/iu;
const REQUIRED_BLOB_ARGS = ["filename", "byte_size", "checksum"] as const;

const keyPrefix = (input: ApiV2Input) => `attachments/${input.owner.external_id}/`;

// FilesController#scalar_part?
const scalar = (value: unknown) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function presign({ params }: ApiV2Input) {
  // Sanitizing replaces characters and never empties a name that has any (it strips edge nulls, as here), so only blankness matters.
  if (blank(rubyToS(params.filename).replaceAll("\u0000", ""))) return error400("filename is required");
  const fileSize = rubyToI(rubyToS(params.file_size));
  if (fileSize <= 0n) return error400("file_size is required");
  if (fileSize > MAX_FILE_SIZE) return error400(`file_size exceeds the ${MAX_FILE_SIZE_GB} GB maximum`);
  return notPorted("starting a multipart upload and signing its parts on S3");
}

function complete(input: ApiV2Input) {
  const { params } = input;
  const uploadId = rubyToS(params.upload_id);
  const key = rubyToS(params.key);
  if (blank(uploadId)) return error400("upload_id is required");
  if (blank(key)) return error400("key is required");
  if (blankParam(params.parts)) return error400("parts is required");
  if (!key.startsWith(keyPrefix(input))) return error400("invalid key");
  // Array(params[:parts]): a hash is one part, any other scalar is one part that is not a hash.
  const parts = Array.isArray(params.parts) ? params.parts : [params.parts];
  if (!parts.every((part) => isHash(part) && scalar(part.part_number) && scalar(part.etag)))
    return error400("each part must have scalar part_number and etag values");
  return notPorted("completing a multipart upload on S3");
}

function abort(input: ApiV2Input) {
  const { params } = input;
  if (blank(rubyToS(params.upload_id))) return error400("upload_id is required");
  const key = rubyToS(params.key);
  if (blank(key)) return error400("key is required");
  if (!key.startsWith(keyPrefix(input))) return error400("invalid key");
  return notPorted("aborting a multipart upload on S3");
}

const FILES = [
  ["/v2/files/presign", presign],
  ["/v2/files/complete", complete],
  ["/v2/files/abort", abort],
] as const;

registerApiV2(
  ...FILES.map(([pattern, run]) => ({
    method: "POST",
    pattern,
    scopes: EDIT_PRODUCTS_SCOPES,
    run,
  })),
);

// ---------------------------------------------------------------------------------------------------------------------
// DirectUploadsController

// `params[:purpose].to_s == "media"`: only the string itself matches, whatever else it is.
const mediaPurpose = (params: Params) => params.purpose === "media";

// Number#to_i or String#to_i of a permitted scalar; `true.to_i` is a NoMethodError, which stays in Rails.
function byteSizeOf(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === "string") return rubyToI(value);
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER)
    return BigInt(Math.trunc(value));
  return notPorted("a byte_size that is a boolean or a number outside the safe range");
}

function createDirectUpload({ params }: ApiV2Input) {
  const blob = params.blob;
  if (!isHash(blob)) return error400("blob must be an object");
  // `params.require(:blob)` raises ParameterMissing on an empty hash, which the action rescues into a 400.
  if (Object.keys(blob).length === 0) return error400("param is missing or the value is empty or invalid: blob");

  // `.permit(:filename, :byte_size, :checksum, :content_type)` drops anything that is not a scalar.
  const permitted = Object.fromEntries(
    ["filename", "byte_size", "checksum", "content_type"]
      .filter((name) => name in blob && (blob[name] === null || scalar(blob[name])))
      .map((name) => [name, blob[name]]),
  );
  const missing = REQUIRED_BLOB_ARGS.find((name) => !(name in permitted));
  if (missing !== undefined) return error400(`${missing} is required`);
  const byteSize = byteSizeOf(permitted.byte_size);
  if (byteSize <= 0n) return error400("byte_size is required");

  const media = mediaPurpose(params);
  if (media && byteSize > MEDIA_MAX_IMAGE_SIZE)
    return error400(`byte_size exceeds the ${MEDIA_MAX_IMAGE_SIZE / BYTES_PER_MB} MB maximum for media uploads`);
  if (!media && byteSize > MAX_FILE_SIZE) return error400(`byte_size exceeds the ${MAX_FILE_SIZE_GB} GB maximum`);

  const contentType = permitted.content_type;
  const allowed =
    typeof contentType === "string" &&
    (media
      ? MEDIA_ALLOWED_CONTENT_TYPES.test(contentType) &&
        !MEDIA_DISALLOWED_CONTENT_TYPES.includes(contentType.toLowerCase())
      : ALLOWED_CONTENT_TYPES.test(contentType));
  if (!allowed)
    return error400(media ? "content_type must be an image type." : "content_type must be JPEG, PNG, GIF, or video.");
  return notPorted("reserving a blob and signing its direct upload");
}

// authorize_upload_scope!: `edit_profile` (twice: doorkeeper, then require_oauth_scope!) for the media library, `edit_products` otherwise.
registerApiV2({
  method: "POST",
  pattern: "/v2/direct_uploads",
  scopes: (params) => (mediaPurpose(params) ? ["edit_profile"] : EDIT_PRODUCTS_SCOPES),
  requireScope: (params) => (mediaPurpose(params) ? ["edit_profile"] : undefined),
  run: createDirectUpload,
});
