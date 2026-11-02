// app/models/product_review_video.rb, for the moderation a seller does from the mobile app: `approved!` and `rejected!`.
import { Prisma, type ProductReviewVideo } from "@prisma/client";

import { defineModel, type Callback } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export const APPROVAL_STATUSES = ["pending_review", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// `validates :video_file, presence: true` (has_one, as: :record)
const videoFilePresent: Callback<ProductReviewVideo> = {
  name: "validates_presence_of video_file",
  async run(record) {
    const [row] = await selectRows(
      Prisma.sql`SELECT 1 AS present FROM ${table("video_files")} WHERE ${column("video_files", "record_id")} = ${record.get("id")} AND ${column("video_files", "record_type")} = 'ProductReviewVideo' LIMIT 1`,
    );
    if (!row) record.errors.add("video_file", "can't be blank");
  },
};

export const ProductReviewVideos = defineModel<ProductReviewVideo>({
  rubyClass: "ProductReviewVideo",
  prismaModel: "ProductReviewVideo",
  delegate: (tx) => tx.productReviewVideo as never,
  validations: [videoFilePresent],
});

export type ProductReviewVideoRecord = ModelRecord<ProductReviewVideo>;

// ProductReviewVideo.alive.find_by(id:)
export async function findAliveVideo(id: bigint | number): Promise<ProductReviewVideoRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_review_videos`.*")} FROM ${table("product_review_videos")} WHERE ${column("product_review_videos", "id")} = ${id} AND ${column("product_review_videos", "deleted_at")} IS NULL LIMIT 1`,
  );
  return row ? ProductReviewVideos.load(castRow<ProductReviewVideo>("ProductReviewVideo", row)) : null;
}

// The `<status>!` methods: under the review's row lock, every other video of the review already in that status is soft-deleted
// (Deletable#mark_deleted!), then the video itself takes the status (`update!`, which writes nothing when it already has it).
export async function setApprovalStatusBang(video: ProductReviewVideoRecord, status: ApprovalStatus, now: () => Date = () => new Date()): Promise<void> {
  await transaction(async () => {
    await selectRows(Prisma.sql`SELECT 1 FROM ${table("product_reviews")} WHERE ${column("product_reviews", "id")} = ${video.get("product_review_id")} FOR UPDATE`);
    const others = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_review_videos`.*")} FROM ${table("product_review_videos")} WHERE ${column("product_review_videos", "product_review_id")} = ${video.get("product_review_id")} AND ${column("product_review_videos", "id")} != ${video.get("id")} AND ${column("product_review_videos", "approval_status")} = ${status}`,
    );
    for (const row of others) {
      const other = ProductReviewVideos.load(castRow<ProductReviewVideo>("ProductReviewVideo", row));
      await ProductReviewVideos.updateBang(other, { deleted_at: now() }, { now });
    }
    await ProductReviewVideos.updateBang(video, { approval_status: status }, { now });
  });
}
