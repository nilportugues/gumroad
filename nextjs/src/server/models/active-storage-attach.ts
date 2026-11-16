// `user.avatar.attach(io:, filename:, content_type:)` then `avatar.blob.save!` and `avatar.analyze` (activestorage 8.1, has_one_attached :avatar
// on the public bucket), as User#twitter_picture_url and User#google_picture_url run it: a blob built from the bytes (MD5 checksum, size, the
// content type Marcel reads from the magic bytes, a key of 28 base36 characters), the blob and attachment rows and the user's touch in one
// transaction, the bucket upload after it commits, then the analysis Rails runs inline (width and height into the blob's metadata) and the
// AnalyzeJob its create_commit hook enqueued.
//
// Not ported, each thrown as `AvatarNotPorted` (the callers run after a single-use code was spent, so they cannot hand back):
//  - a picture that is not a PNG or a JPEG, or is over MAXIMUM_AVATAR_FILE_SIZE: `avatar_is_valid` fails the save, and Rails then leaves a
//    saved blob with no attachment and no file;
//  - the 400x400 variant `avatar_url` renders at the end of both callers: ImageMagick's re-encoding of the picture is not reproducible, so
//    the variant rows and file are left to the first render that asks for one;
//  - the reads Rails makes of the bucket (an existence check before the upload, the blob downloaded for the analysis): Node analyses the
//    bytes it holds, and the rows and file written are the same.
import { createHash, randomInt, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";

import { configuredServiceName } from "../infra/active-storage.ts";
import { identifyImage, UnidentifiedImage } from "../infra/image-identify.ts";
import { getS3Client } from "../infra/signed-urls.ts";
import { storageConfig } from "../infra/storage.ts";

import { analyzeBlobLater } from "./active-storage-blob.ts";
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, execute, selectRows, table } from "./sql.ts";
import { type PendingAvatar, type UserRecord, Users } from "./user.ts";

// User::Validations::MAXIMUM_AVATAR_FILE_SIZE
export const MAXIMUM_AVATAR_FILE_SIZE = 10 * 1024 * 1024;
// ActiveStorage::Blob.generate_unique_secure_token (length 28, SecureRandom.base36)
const BLOB_KEY_LENGTH = 28;
const BASE36 = 36;
const BLOBS = "active_storage_blobs";
const ATTACHMENTS = "active_storage_attachments";
const PUBLIC_READ = "public-read";

export class AvatarNotPorted extends Error {
  constructor(what: string) {
    super(`not ported: ${what}`);
    this.name = "NotPorted";
  }
}

export type AvatarPicture = { bytes: Buffer; filename: string };

// ActiveStorage::Filename#sanitized: what a reader of the blob sees. The column holds the name as `attach` was given it, so nothing here writes it.
const FILENAME_UNSAFE = /[‮%$|:;/<>?*"\t\r\n\\]/gu;
export const sanitizeFilename = (filename: string) => filename.trim().replaceAll(FILENAME_UNSAFE, "-");

const secureToken = () => Array.from({ length: BLOB_KEY_LENGTH }, () => randomInt(BASE36).toString(BASE36)).join("");

// File.basename(url): the last segment of the path, trailing slashes ignored, the query string and fragment kept.
export function basename(value: string): string {
  const trimmed = value.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export type AttachDeps = { now: () => Date; uuid?: () => string; putObject?: typeof putPublicObject };

async function putPublicObject(key: string, body: Buffer, contentType: string, checksum: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: storageConfig().publicStorageS3Bucket,
      Key: key,
      Body: body,
      ContentMD5: checksum,
      ContentType: contentType,
      ACL: PUBLIC_READ,
    }),
  );
}

export async function attachAvatar(user: UserRecord, picture: AvatarPicture, deps: AttachDeps): Promise<void> {
  const { bytes } = picture;
  if (bytes.length > MAXIMUM_AVATAR_FILE_SIZE) throw new AvatarNotPorted("an avatar over the maximum size");
  let info;
  try {
    info = identifyImage(bytes);
  } catch (error) {
    if (error instanceof UnidentifiedImage) throw new AvatarNotPorted(error.message);
    throw error;
  }
  // `record.save` of the attach: a user that no longer validates attaches nothing.
  if (!(await Users.valid(user))) throw new AvatarNotPorted("an avatar for a user that no longer validates");

  const userId = user.get("id");
  const key = secureToken();
  const checksum = createHash("md5").update(bytes).digest("base64");
  const { filename } = picture;
  const uuid = deps.uuid ?? randomUUID;
  const put = deps.putObject ?? putPublicObject;

  const blobId = await transaction(async () => {
    const at = deps.now();
    await execute(
      Prisma.sql`INSERT INTO ${table(BLOBS)} (${Prisma.raw("`key`, `filename`, `content_type`, `metadata`, `byte_size`, `checksum`, `created_at`, `service_name`")}) VALUES (${key}, ${filename}, ${info.contentType}, ${'{"identified":true}'}, ${bytes.length}, ${checksum}, ${at}, ${configuredServiceName()})`,
    );
    const [blob] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
    await execute(
      Prisma.sql`INSERT INTO ${table(ATTACHMENTS)} (${Prisma.raw("`name`, `record_type`, `record_id`, `blob_id`, `created_at`")}) VALUES ('avatar', 'User', ${userId}, ${blob!.id}, ${at})`,
    );
    await Users.touch(user, { now: deps.now, deferred: true });
    // The attachment's after_create_commit hook (analyze_blob_later), enqueued once this commits.
    await afterCommitEverywhere(() => analyzeBlobLater(blob!.id, uuid));
    return blob!.id;
  });

  // after_commit: the upload of the new attachment.
  await put(key, bytes, info.contentType, checksum);

  // `avatar.blob.save!` saves nothing but still touches the attachments, so the user.
  await transaction(async () => {
    await Users.touch(user, { now: deps.now, deferred: true });
  });

  // `avatar.analyze`
  await transaction(async () => {
    const metadata = JSON.stringify({ identified: true, width: info.width, height: info.height, analyzed: true });
    await execute(
      Prisma.sql`UPDATE ${table(BLOBS)} SET ${column(BLOBS, "metadata")} = ${metadata} WHERE ${column(BLOBS, "id")} = ${blobId}`,
    );
    await Users.touch(user, { now: deps.now, deferred: true });
  });
}

// Marcel::MimeType.for(io, name:, declared_type:): the type the bytes' magic names, else the declared type. Only the signatures of the types a
// picture host may send are known here (an avatar is valid as a PNG or a JPEG, and every other type fails the same validation); bytes that
// match none are taken for the declared type.
const MAGIC: [string, Buffer][] = [
  ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
  ["image/gif", Buffer.from("GIF87a", "latin1")],
  ["image/gif", Buffer.from("GIF89a", "latin1")],
  ["application/pdf", Buffer.from("%PDF-", "latin1")],
];
const RIFF_END = 4;
const WEBP_TAG_START = 8;
const WEBP_TAG_END = 12;
const BINARY = "application/octet-stream";

export function marcelContentType(bytes: Buffer, declared: string): string {
  const fallback = declared.split(";")[0]!.trim().toLowerCase();
  for (const [type, signature] of MAGIC) if (bytes.subarray(0, signature.length).equals(signature)) return type;
  if (
    bytes.toString("latin1", 0, RIFF_END) === "RIFF" &&
    bytes.toString("latin1", WEBP_TAG_START, WEBP_TAG_END) === "WEBP"
  )
    return "image/webp";
  return fallback === "" ? BINARY : fallback;
}

export type AssignedAvatar = { bytes: Buffer; filename: string; declaredType: string };

// `user.avatar.attach(io:, filename:, content_type:)` then `user.avatar.blob.save!`, as User#google_picture_url runs it (its analysis is
// skipped, so the blob keeps `{"identified":true}`). The blob row is written at once. The attachment row, the upload and the AnalyzeJob follow
// the user's save: the caller's own when the record is new or has changes, the one `attach` runs itself when it is persisted and unchanged.
// A type that is no PNG or JPEG fails that save's validation and leaves the blob behind.
export async function assignAvatar(user: UserRecord, picture: AssignedAvatar, deps: AttachDeps): Promise<void> {
  const { bytes } = picture;
  const contentType = marcelContentType(bytes, picture.declaredType);
  const immediate = user.persisted && !user.hasChangesToSave();
  const checksum = createHash("md5").update(bytes).digest("base64");
  const key = secureToken();
  const { filename } = picture;
  const uuid = deps.uuid ?? randomUUID;
  const put = deps.putObject ?? putPublicObject;

  const blobId = await transaction(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(BLOBS)} (${Prisma.raw("`key`, `filename`, `content_type`, `metadata`, `byte_size`, `checksum`, `created_at`, `service_name`")}) VALUES (${key}, ${filename}, ${contentType}, ${'{"identified":true}'}, ${bytes.length}, ${checksum}, ${deps.now()}, ${configuredServiceName()})`,
    );
    const [blob] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
    return blob!.id;
  });

  const pending: PendingAvatar = {
    contentType,
    async save(record, now) {
      await execute(
        Prisma.sql`INSERT INTO ${table(ATTACHMENTS)} (${Prisma.raw("`name`, `record_type`, `record_id`, `blob_id`, `created_at`")}) VALUES ('avatar', 'User', ${record.get("id")}, ${blobId}, ${now()})`,
      );
      // The attachment's after_create_commit hook (analyze_blob_later) and the bucket upload both wait for the commit.
      await afterCommitEverywhere(() => analyzeBlobLater(blobId, uuid));
      await afterCommitEverywhere(() => put(key, bytes, contentType, checksum));
    },
  };
  user.ivars.pending_avatar = pending;
  if (immediate) await Users.save(user, { now: deps.now });
}
