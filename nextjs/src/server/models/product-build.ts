// Port of the validated save of app/models/product_build.rb (it has no callbacks): what `promote!` writes to a build and to the build it
// supersedes. Creating a build and the unpack bookkeeping are not ported.
import type { ProductBuild } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesNumericalityOf, validatesPresenceOf } from "./runtime/validators.ts";

export const PRODUCT_BUILD_STATUSES = ["uploaded", "live", "superseded"] as const;
export const MAX_BUILD_BYTE_SIZE = 2 * 1024 ** 3;
export const PRODUCT_BUILD_DISPLAY_NAME_MAX_LENGTH = 200;

const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };

export const ProductBuilds = defineModel<ProductBuild>({
  rubyClass: "ProductBuild",
  prismaModel: "ProductBuild",
  delegate: (tx) => tx.productBuild as never,
  validations: [
    belongsToRequired<ProductBuild>(PRODUCT),
    validatesPresenceOf<ProductBuild>(["number", "source_url", "storage_key"]),
    validatesNumericalityOf<ProductBuild>(["byte_size"], {
      greater_than: 0,
      less_than_or_equal_to: MAX_BUILD_BYTE_SIZE,
    }),
    validatesInclusionOf<ProductBuild>(["status"], { in: PRODUCT_BUILD_STATUSES }),
  ],
});

// Whether the stored row passes the validations above, for a caller that must know before its first write.
export function productBuildValid(row: ProductBuild): boolean {
  const byteSize = Number(row.byte_size);
  return (
    row.number != null &&
    typeof row.source_url === "string" &&
    row.source_url.trim() !== "" &&
    typeof row.storage_key === "string" &&
    row.storage_key.trim() !== "" &&
    byteSize > 0 &&
    byteSize <= MAX_BUILD_BYTE_SIZE &&
    (PRODUCT_BUILD_STATUSES as readonly string[]).includes(row.status)
  );
}

// String#truncate(200) of the product name, as `promote!` titles the file: 197 characters and "...", counted in characters.
export function truncateName(name: string, max = PRODUCT_BUILD_DISPLAY_NAME_MAX_LENGTH): string {
  const chars = Array.from(name);
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : name;
}
