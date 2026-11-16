// Port of app/sidekiq/rename_product_file_worker.rb up to the storage copy: a missing file or one already deleted from the CDN is left
// alone, and so is one whose display name already is the name in its url. A file elsewhere than S3 and a namespaced S3 file whose name
// differs fail with the Ruby errors the golden recorded; an S3 file whose name differs is copied to a new key and saved, which stays
// with Rails and is handed back right after the read, like a file whose owner is needed to read its name (it is not namespaced by its
// url) or whose extension ends in a dot. Nothing has been written when a job is handed back.
// Golden: __fixtures__/rename-product-file-worker.golden.json (scripts/golden/rename-product-file-worker.rb); the storage copy was
// replaced there.
import { type ProductFile } from "@prisma/client";

import { storageConfig } from "../../server/infra/storage.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { s3Fields } from "../../server/models/product-file.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";

import { RubyNoMethodError } from "./calculate-sale-numbers-worker.ts";
import { modelJob } from "./support/job-deps.ts";

const GUID_LENGTH = 32;
// The url of a file a collaborator or the seller uploaded: `<namespace>/<namespace>/<guid>/original/<name>`, so reading its name
// does not need the owner.
const NAMESPACED = new RegExp(`^[^/]+/[^/]+/[A-Za-z0-9]{${GUID_LENGTH}}/original/`, "u");

class RubyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

// `ProductFile#rename_in_storage` for a file that is not under S3_BASE_URL: it has no object to copy.
function renameOutsideStorage(file: ProductFile): never {
  // filename_with_extension is nil without an S3 filename and a file type, and File.extname(nil) fails.
  if (file.filetype === null || file.filetype.trim() === "") {
    throw new RubyTypeError("no implicit conversion of nil into String");
  }
  throw new RubyNoMethodError("undefined method 'presigned_url' for nil");
}

export const renameProductFileWorkerWith = modelJob({ min: 1 }, async ([productFileId]) => {
  // `find_by(id: nil)` still asks the database.
  const id = await beforeSideEffects(() =>
    productFileId === null ? null : recordIdFrom(productFileId, "ProductFile.find_by"),
  );
  const file = await findOneBy<ProductFile>("ProductFile", "id", id, true);
  if (file === null || file.deleted_from_cdn_at !== null) return;

  const url = file.url;
  const baseUrl = storageConfig().s3BaseUrl;
  if (!url?.startsWith(baseUrl)) {
    // s3_display_name is nil, which only a missing display name equals.
    if (file.display_name === null) return;
    renameOutsideStorage(file);
  }

  if (!NAMESPACED.test(url.slice(baseUrl.length)) || url.endsWith(".")) {
    throw new HandBackToRuby(
      "the name of an S3 file that is not namespaced by its url needs its owner, or ends in a dot",
    );
  }
  const fields = s3Fields(url, null)!;
  const s3DisplayName =
    fields.extension.length > 0 ? fields.filename.slice(0, -fields.extension.length) : fields.filename;
  if (file.display_name === s3DisplayName) return;
  if (file.display_name === null) throw new RubyNoMethodError("undefined method 'ends_with?' for nil");

  throw new HandBackToRuby("the copy of an S3 file to its new key is not ported");
});

export const renameProductFileWorker = renameProductFileWorkerWith();
