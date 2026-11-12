// Port of the write side of app/models/product_file.rb that ProductFile#delete! reaches: the validated save (url, ISBN, owner and
// thumbnail checks, the filegroup derived from the S3 extension), PaperTrail, the cache invalidation, the HLS rendition cleanup, the
// commit callbacks and the subtitle file deletes. Creating a file, a url or display-name change, an ISBN or thumbnail edit and the
// archive callbacks are not ported: the callbacks that only fire on those throw NotPortedError, which the delete cannot reach.
// Golden: worker/jobs/__fixtures__/delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb).
import { Prisma, type ProductFile, type SubtitleFile, type TranscodedVideo } from "@prisma/client";

import { storageConfig } from "../infra/storage.ts";

import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { associationCache, loadBelongsTo, setAssociation, type BelongsTo } from "./concerns/rails-validations.ts";
import { invalidateProductCache, enqueueLinkIndexUpdate } from "./link.ts";
import { ProductFileFlags, s3Fields } from "./product-file.ts";
import { classifyTaxonomyAttributes } from "./taxonomy-attribute-classifier.ts";
import { defineModel, type CallbackContext, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord, Row } from "./runtime/record.ts";
import { isBlank, validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { SubtitleFileDeletable, loadSubtitleFile } from "./subtitle-file.ts";
import { TranscodedVideoDeletable, TranscodedVideos } from "./transcoded-video.ts";
import { NoMethodError, NotPortedError } from "./user.ts";

export type ProductFileRecord = ModelRecord<ProductFile>;

// ProductFile::SUPPORTED_THUMBNAIL_IMAGE_CONTENT_TYPES and MAXIMUM_THUMBNAIL_FILE_SIZE
const SUPPORTED_THUMBNAIL_IMAGE_CONTENT_TYPES = /jpeg|gif|png|jpg/iu;
const MAXIMUM_THUMBNAIL_FILE_SIZE = 5 * 1024 * 1024;
// config/initializers/004_constants.rb FILE_REGEX, in declaration order: the first match names the group.
const FILE_REGEX: [string, RegExp][] = [
  ["archive", /rar|zip|tar/iu],
  ["audio", /mp3|aac|wma|wav|m4a|flac/iu],
  ["epub_document", /epub/iu],
  ["executable", /exe/iu],
  ["document", /doc|docx|pdf|ppt|pptx/iu],
  ["image", /jpeg|gif|png|jpg|tif|bmp|tiff/iu],
  ["mobi_document", /mobi/iu],
  ["psd_image", /psd/iu],
  ["text_document", /txt|xml|json/iu],
  ["video", /mp4|m4v|mov|mpeg|mpeg4|wmv|movie|ogv|avi|webm/iu],
  ["word_document", /doc/iu],
];
// Page size the link cache and ES updates use are the link's; the delay of check_pdf_stampability is ours.
const PDF_STAMPABILITY_DELAY_SECONDS = 5;

const LINK: BelongsTo = { name: "link", foreignKey: "link_id", targetTable: "links", targetModel: "Link" };
const INSTALLMENT: BelongsTo = {
  name: "installment",
  foreignKey: "installment_id",
  targetTable: "installments",
  targetModel: "Installment",
};

// normalizes :isbn, :filetype
const normalizeIsbn = (value: unknown) =>
  typeof value !== "string" || isBlank(value)
    ? null
    : value
        .trim()
        .toUpperCase()
        .replaceAll(/[\s\u2013\u2014\u2212]/gu, "-");
const paperTrail = hasPaperTrail<ProductFile>("ProductFile", {
  itemType: "ProductFile",
  normalizers: { isbn: normalizeIsbn, filetype: (value) => (typeof value === "string" ? value.toLowerCase() : value) },
});

const isLink = (record: ProductFileRecord) => record.get("filetype") === "link";
const isPdf = (record: ProductFileRecord) => record.get("filetype") === "pdf";
// S3Retrievable#s3?
const isS3 = (record: ProductFileRecord) => {
  const url = record.get("url");
  return url != null && !isBlank(url) && url.startsWith(storageConfig().s3BaseUrl);
};
// S3Retrievable#s3_extension: File.extname of the url, nil off S3.
const s3Extension = (record: ProductFileRecord) =>
  isS3(record) ? (s3Fields(record.get("url"), null)?.extension ?? "") : null;
const supportsIsbn = (record: ProductFileRecord) =>
  record.get("filetype") === "epub" || isPdf(record) || record.get("filetype") === "mobi";

// WithFileProperties#determine_and_set_filegroup
function determineAndSetFilegroup(record: ProductFileRecord, extension: string) {
  // normalizes :filetype, with: proc(&:downcase)
  record.set("filetype", extension.toLowerCase());
  for (const [name, pattern] of FILE_REGEX) {
    if (pattern.test(extension)) {
      record.set("filegroup", name.split("_").at(-1)!);
      break;
    }
  }
  if (record.get("filegroup") == null) record.set("filegroup", "url");
}

// IsbnValidator
function validIsbn(value: string): boolean {
  const digits = value.replaceAll("-", "");
  if (digits.length === 10) {
    if (!/^\d{9}[\dXx]$/u.test(digits)) return false;
    const check = digits.endsWith("X") || digits.endsWith("x") ? 10 : Number(digits.at(-1));
    const sum = [...digits.slice(0, -1)].reduce((total, d, i) => total + (i + 1) * Number(d), 0);
    return sum % 11 === check;
  }
  if (digits.length === 13) {
    if (!/^\d{13}$/u.test(digits)) return false;
    const sum = [...digits].reduce((total, d, i) => total + (i % 2 === 0 ? 1 : 3) * Number(d), 0);
    return sum % 10 === 0;
  }
  return false;
}

type Thumbnail = { attachment: Row | null; blob: Row | null };
const THUMBNAIL = Symbol("thumbnail");

// `thumbnail.attached?` and, for an attached one, its blob. The has_one is cached on the record, so a second validation asks nothing.
async function loadThumbnail(record: ProductFileRecord, ctx: CallbackContext): Promise<Thumbnail> {
  const cached = record.ivars[THUMBNAIL as unknown as string] as Thumbnail | undefined;
  if (cached) return cached;
  const [attachment = null] = await ctx.tx.$queryRaw<Row[]>(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_id")} = ${record.get("id")} AND ${column("active_storage_attachments", "record_type")} = 'ProductFile' AND ${column("active_storage_attachments", "name")} = 'thumbnail' LIMIT 1`,
  );
  let blob: Row | null = null;
  if (attachment) {
    [blob = null] = await ctx.tx.$queryRaw<Row[]>(
      Prisma.sql`SELECT ${Prisma.raw("`active_storage_blobs`.*")} FROM ${table("active_storage_blobs")} WHERE ${column("active_storage_blobs", "id")} = ${attachment.blob_id} LIMIT 1`,
    );
  }
  const loaded = { attachment, blob };
  record.ivars[THUMBNAIL as unknown as string] = loaded;
  return loaded;
}

// The link a file was loaded through (the has_many's inverse), else read.
async function linkOf(record: ProductFileRecord): Promise<Row | null> {
  const cached = associationCache(record).get("link");
  if (cached && cached.foreignKey === record.get("link_id")) return cached.row;
  const id = record.get("link_id");
  if (id == null) return null;
  const [row = null] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`,
  );
  const link = row ? castRow<Row>("Link", row) : null;
  setAssociation(record, "link", id, link);
  return link;
}

const notPorted = (what: string): never => {
  throw new NotPortedError(what, "app/models/product_file.rb");
};

export const ProductFiles = defineModel<ProductFile>({
  rubyClass: "ProductFile",
  prismaModel: "ProductFile",
  delegate: (tx) => tx.productFile as never,
  beforeValidation: [
    {
      // before_validation :set_filegroup
      name: "set_filegroup",
      run(record) {
        // PaperTrail lists the two normalized attributes right after the ones the delete wrote, ahead of the filegroup this sets.
        record.touch("isbn");
        record.touch("filetype");
        if (isLink(record)) {
          record.set("filegroup", "link");
          return;
        }
        const extension = s3Extension(record)?.replaceAll(".", "");
        if (extension != null && !isBlank(extension)) determineAndSetFilegroup(record, extension);
      },
    },
  ],
  validations: [
    validatesPresenceOf<ProductFile>(["url"]),
    {
      name: "validates :isbn, isbn: true, allow_nil: true, if: :supports_isbn?",
      run(record) {
        if (!supportsIsbn(record)) return;
        const isbn = record.get("isbn");
        if (isbn !== null && !validIsbn(isbn))
          record.errors.add("isbn", "invalid", { message: "is not a valid ISBN-10 or ISBN-13" });
      },
    },
    {
      name: "validates :isbn, absence: { unless: :supports_isbn? }",
      run(record) {
        if (supportsIsbn(record)) return;
        record.touch("isbn");
        if (!isBlank(record.get("isbn"))) record.errors.add("isbn", "present");
      },
    },
    {
      name: "valid_url?",
      on: "create",
      run: () => notPorted("Creating a ProductFile"),
    },
    {
      name: "belongs_to_product_or_installment",
      async run(record, ctx) {
        const link = await loadBelongsTo(record, LINK, ctx);
        if (link !== null) {
          if ((await loadBelongsTo(record, INSTALLMENT, ctx)) === null) return;
        } else if ((await loadBelongsTo(record, INSTALLMENT, ctx)) !== null) {
          return;
        }
        record.errors.add("base", "invalid", {
          message: "A file needs to either belong to a product or an installment",
        });
      },
    },
    {
      name: "thumbnail_is_vaild",
      async run(record, ctx) {
        const { attachment, blob } = await loadThumbnail(record, ctx);
        if (attachment === null) return;
        if (blob === null)
          throw new NoMethodError("undefined method 'image?' for an instance of ActiveStorage::Attached::One");
        // Blob#image? is `content_type.to_s.start_with?("image")`.
        const contentType = (blob.content_type as string | null) ?? "";
        if (!contentType.startsWith("image") || !SUPPORTED_THUMBNAIL_IMAGE_CONTENT_TYPES.test(contentType)) {
          record.errors.add("base", "invalid", { message: "Please upload a thumbnail in JPG, PNG, or GIF format." });
          return;
        }
        if (BigInt(blob.byte_size as bigint | number) > BigInt(MAXIMUM_THUMBNAIL_FILE_SIZE)) {
          record.errors.add("base", "invalid", {
            message: "Could not process your thumbnail, please upload an image with size smaller than 5 MB.",
          });
        }
      },
    },
  ],
  beforeSave: [
    {
      // JsonData#merge_json_data_with_current_row asks `json_data_changed?` of a persisted row, which loads the attribute.
      name: "merge_json_data_with_current_row",
      run(record, ctx) {
        record.ivars.now = ctx.now;
        record.touch("json_data");
        if (record.persisted && record.attributeChanged("json_data")) notPorted("Changing ProductFile#json_data");
      },
    },
  ],
  afterUpdate: [
    ...paperTrail.afterUpdate,
    {
      // after_update :invalidate_archives_for_detected_type, if: :detected_type_changed?
      name: "invalidate_archives_for_detected_type",
      if: (record) => record.savedChangeTo("filetype") && isS3(record) && s3Extension(record) === "",
      run: () => notPorted("Invalidating archives for a detected type"),
    },
  ],
  afterSave: [
    {
      name: "invalidate_product_cache",
      async run(record, ctx) {
        const link = await linkOf(record);
        if (link !== null) await invalidateProductCache(link.id as bigint, ctx.now);
      },
    },
    {
      // Editor removals, product deletion and build replacement each mark a file deleted differently, so its HLS renditions are retired here.
      name: "delete_transcoded_videos",
      if: (record) => record.savedChangeTo("deleted_at", { from: null }),
      async run(record, ctx) {
        const columns = Prisma.join(
          TRANSCODED_VIDEO_COLUMNS.map((name) => column("transcoded_videos", name)),
          ", ",
        );
        const videos = await selectRows<TranscodedVideo>(
          Prisma.sql`SELECT ${columns} FROM ${table("transcoded_videos")} WHERE ${column("transcoded_videos", "streamable_id")} = ${record.get("id")} AND ${column("transcoded_videos", "streamable_type")} = 'ProductFile' AND ${column("transcoded_videos", "deleted_at")} IS NULL`,
        );
        for (const row of videos) {
          const video = TranscodedVideos.load(castRow<TranscodedVideo>("TranscodedVideo", row));
          // The has_many's inverse: `streamable` is this very record, and its foreign key reads first.
          video.touch("streamable_id");
          await TranscodedVideoDeletable.markDeletedBang(video, { now: ctx.now });
          // TranscodedVideo#mark_deleted!
          if (
            ProductFileFlags.isSet(record.get("flags"), "is_transcoded_for_hls") &&
            !(await hasAliveDuplicateVideo(video))
          ) {
            await ProductFiles.updateBang(
              record,
              { flags: ProductFileFlags.set(record.get("flags"), "is_transcoded_for_hls", false) },
              { now: ctx.now },
            );
          }
        }
      },
    },
  ],
  afterCommit: [
    // Declaration order; the runtime runs them in reverse.
    { name: "schedule_file_analyze", on: "create", run: () => notPorted("Creating a ProductFile") },
    {
      name: "stamp_existing_pdfs_if_needed",
      on: "update",
      if: (record) => record.savedChangeTo("flags") && ProductFileFlags.isSet(record.get("flags"), "pdf_stamp_enabled"),
      run: () => notPorted("Turning PDF stamping on"),
    },
    {
      // Discover::TaxonomyAttributeClassifier.classify!(link): writes the product, through the instance its files were loaded from.
      name: "classify_product_taxonomy_attributes",
      on: ["create", "update"],
      if: (record) => record.get("link_id") != null,
      async run(record) {
        const link = await linkOf(record);
        if (link === null) throw new NoMethodError("undefined method 'taxonomy' for nil");
        await classifyTaxonomyAttributes(link, record.ivars.now as (() => Date) | undefined);
      },
    },
    {
      name: "schedule_rename_in_storage",
      on: "update",
      if: (record) => record.savedChangeTo("display_name"),
      run: () => notPorted("Renaming a stored file"),
    },
    {
      name: "update_product_filetypes_index",
      on: "update",
      async run(record) {
        if ((await linkOf(record)) === null || !record.savedChangeTo("filetype")) return;
        const now = record.ivars.now as (() => Date) | undefined;
        await enqueueLinkIndexUpdate(record.get("link_id")!, ["filetypes"], now);
      },
    },
    {
      name: "rebuild_archives_for_detected_type",
      on: "update",
      if: (record) => record.savedChangeTo("filetype") && isS3(record) && s3Extension(record) === "",
      run: () => notPorted("Rebuilding archives for a detected type"),
    },
    {
      name: "reanalyze_moved_file",
      on: "update",
      if: (record) => record.savedChangeTo("url") && isS3(record) && s3Extension(record) === "",
      run: () => notPorted("Reanalyzing a moved file"),
    },
    {
      name: "check_pdf_stampability",
      on: "update",
      async run(record) {
        if ((await linkOf(record)) === null) return;
        if (!ProductFileFlags.isSet(record.get("flags"), "pdf_stamp_enabled") || record.savedChangeTo("flags")) return;
        if (!record.savedChangeTo("filetype", { to: "pdf" })) return;
        await performAsync("PdfUnstampableNotifierJob", [Number(record.get("link_id"))], {
          delaySeconds: PDF_STAMPABILITY_DELAY_SECONDS,
        });
      },
    },
  ],
});

export const ProductFileDeletable = deletable(ProductFiles);

// TranscodedVideo's columns in schema order, minus the ignored product_file_id.
const TRANSCODED_VIDEO_COLUMNS = [
  "id",
  "link_id",
  "original_video_key",
  "transcoded_video_key",
  "job_id",
  "state",
  "created_at",
  "updated_at",
  "flags",
  "deleted_from_cdn_at",
  "deleted_at",
  "last_accessed_at",
  "streamable_type",
  "streamable_id",
];

// TranscodedVideo#has_alive_duplicate_files?
async function hasAliveDuplicateVideo(video: ModelRecord<TranscodedVideo>): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("transcoded_videos")} WHERE ${column("transcoded_videos", "deleted_at")} IS NULL AND ${column("transcoded_videos", "transcoded_video_key")} = ${video.get("transcoded_video_key")} LIMIT 1`,
  );
  return rows.length > 0;
}

// A file as `product.product_files` hands it out: its link is the product that loaded it, and the foreign key reads first.
export function loadProductFile(row: ProductFile, product: Row): ProductFileRecord {
  const record = ProductFiles.load(row);
  record.touch("link_id");
  setAssociation(record, "link", row.link_id, product);
  return record;
}

// ProductFile#delete_all_subtitle_files!
async function deleteAllSubtitleFiles(record: ProductFileRecord, options: SaveOptions) {
  const rows = await selectRows<SubtitleFile>(
    Prisma.sql`SELECT ${Prisma.raw("`subtitle_files`.*")} FROM ${table("subtitle_files")} WHERE ${column("subtitle_files", "product_file_id")} = ${record.get("id")} AND ${column("subtitle_files", "deleted_at")} IS NULL`,
  );
  for (const row of rows) {
    const subtitle = loadSubtitleFile(castRow<SubtitleFile>("SubtitleFile", row));
    subtitle.touch("product_file_id");
    setAssociation(subtitle, "product_file", subtitle.get("product_file_id"), { ...record.attributes });
    await SubtitleFileDeletable.markDeletedBang(subtitle, options);
  }
}

// ProductFile#delete!
export async function deleteProductFileBang(record: ProductFileRecord, options: SaveOptions = {}) {
  await ProductFileDeletable.markDeletedBang(record, options);
  await deleteAllSubtitleFiles(record, options);
}
