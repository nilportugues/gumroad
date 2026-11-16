// app/models/thumbnail.rb, for ThumbnailsController#destroy: soft-deleting a thumbnail, which touches its product
// (`belongs_to :product, touch: true`). Only a thumbnail with an `unsplash_url` is ported; one backed by an uploaded file has a
// storage URL to build and a file validation to run, so the controller hands it to Rails.
import { type Link, type Thumbnail } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { Links } from "./link.ts";
import { findById } from "./row-reads.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { isBlank } from "./runtime/validators.ts";
import { NotPortedError } from "./user.ts";

// `validate :validate_file` checks an alive thumbnail that has no unsplash_url. Deliberate hand-back: the soft delete
// sets `deleted_at` first and never reaches it; any other save of an uploaded thumbnail would need the attachment's content type,
// size and dimensions, which no recording reads.
const validateFile: Callback<Thumbnail> = {
  name: "validate_file",
  run(record) {
    if (record.get("deleted_at") === null && isBlank(record.get("unsplash_url")))
      throw new NotPortedError("Thumbnail#validate_file", "an alive thumbnail backed by an uploaded file");
  },
};

// `touch: true` bumps the product when the save changed anything.
const touchProduct: Callback<Thumbnail> = {
  name: "touch product",
  async run(record, ctx) {
    const productId = record.get("product_id");
    if (productId === null || Object.keys(record.savedChanges).length === 0) return;
    const link = await findById<Link>("Link", BigInt(productId));
    if (link) await Links.touch(Links.load(link), { now: ctx.now, deferred: true });
  },
};

export const Thumbnails = defineModel<Thumbnail>({
  rubyClass: "Thumbnail",
  prismaModel: "Thumbnail",
  delegate: (tx) => tx.thumbnail as never,
  validations: [validateFile],
  afterSave: [touchProduct],
});

export const softDeletion = deletable(Thumbnails);
