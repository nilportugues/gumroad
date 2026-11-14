// Port of app/models/rich_content.rb's writes: has_paper_trail, the entity presence and description schema validations, the two
// validations that run when the description changes, the soft delete, and the license backfill queued after a commit.
//
// A description change whose result Rails would reject (a file of another product, a blocked link scheme) is NotPortedError: the message
// Rails builds for it is not proven by any recording, so the caller hands the request back. Callers that rewrite a page check
// `descriptionWriteRefusal` before their first write; the validations here are the backstop and roll the transaction back.
import { Prisma, type Link, type RichContent } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { associationCache } from "./concerns/rails-validations.ts";
import { LinkFlags } from "./link.ts";
import {
  blockedHrefSchemes,
  embeddedProductFileIds,
  hasLicenseKeyIn,
  isPlainDescription,
} from "./rich-content-description.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

// CreateLicensesForExistingCustomersWorker.perform_in(5.seconds, product.id)
const LICENSE_BACKFILL_DELAY_SECONDS = 5;
const BACKFILL_PRODUCT = "licenseBackfillProduct";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A property the schema types: absent is fine, present must match.
const optional = (node: Record<string, unknown>, key: string, ok: (value: unknown) => boolean) =>
  !(key in node) || ok(node[key]);

function validMark(mark: unknown): boolean {
  return isObject(mark) && typeof mark.type === "string" && optional(mark, "attrs", isObject);
}

function validNode(node: unknown): boolean {
  if (!isObject(node)) return false;
  return (
    optional(node, "type", (v) => typeof v === "string") &&
    optional(node, "attrs", isObject) &&
    optional(node, "content", (v) => Array.isArray(v) && v.every(validNode)) &&
    optional(node, "marks", (v) => Array.isArray(v) && v.every(validMark)) &&
    optional(node, "text", (v) => typeof v === "string")
  );
}

// `validates :description, json: { schema: DESCRIPTION_JSON_SCHEMA }` (JSON::Validator.validate).
export function descriptionMatchesSchema(description: unknown): boolean {
  let value = description;
  if (typeof description === "string") {
    // The json-schema gem reads string data as JSON before validating it; what is not JSON it takes for a URI, which it may open.
    try {
      value = JSON.parse(description) as unknown;
    } catch {
      if (/[/:.\\~?#]/u.test(description))
        throw new NotPortedError("A URI description", "app/validators/json_validator.rb");
      return false;
    }
  }
  return Array.isArray(value) && value.every(validNode);
}

const paperTrail = hasPaperTrail<RichContent>("RichContent", { itemType: "RichContent" });

export const RichContents = defineModel<RichContent>({
  rubyClass: "RichContent",
  prismaModel: "RichContent",
  delegate: (tx) => tx.richContent as never,
  validations: [
    {
      name: "validates_presence_of :entity",
      run(record) {
        // The entity is polymorphic; a page read through its owner has it loaded as the inverse.
        if (!associationCache(record).has("entity"))
          throw new NotPortedError("Loading RichContent#entity", "app/models/rich_content.rb");
      },
    },
    {
      name: "validates_json :description",
      run(record) {
        record.touch("description");
        // `self.human_attribute_name` names the attribute "Content".
        record.errors.humanNames.description = "Content";
        if (!descriptionMatchesSchema(record.get("description"))) record.errors.add("description", "invalid");
      },
    },
    {
      name: "embedded_files_belong_to_product",
      async run(record) {
        if (!record.attributeChanged("description")) return;
        const description = record.get("description");
        if (!Array.isArray(description)) return;
        if (!isPlainDescription(description))
          throw new NotPortedError("An unusual RichContent description", "app/models/rich_content.rb");
        const refusal = await foreignEmbedRefusal(record, description);
        if (refusal !== null) throw new NotPortedError(refusal, "app/models/rich_content.rb");
      },
    },
    {
      name: "link_hrefs_use_permitted_schemes",
      run(record) {
        if (!record.attributeChanged("description")) return;
        const description = record.get("description");
        if (!Array.isArray(description)) return;
        if (!isPlainDescription(description))
          throw new NotPortedError("An unusual RichContent description", "app/models/rich_content.rb");
        if (blockedHrefSchemes(description).length > 0)
          throw new NotPortedError("A RichContent link with a blocked scheme", "app/models/rich_content.rb");
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
  afterSave: [
    {
      // `starts_offering_license_key?` and `owning_product` read the row only, so they are settled before the commit; the queue waits for it.
      name: "settle_license_backfill",
      on: ["create", "update"],
      async run(record) {
        record.ivars[BACKFILL_PRODUCT] = null;
        if (!startsOfferingLicenseKey(record)) return;
        const product = owningProduct(record);
        if (LinkFlags.isSet(product.flags, "is_licensed")) record.ivars[BACKFILL_PRODUCT] = product.id;
      },
    },
  ],
  afterCommit: [
    {
      name: "enqueue_license_backfill",
      on: ["create", "update"],
      async run(record: ModelRecord<RichContent>) {
        const productId = record.ivars[BACKFILL_PRODUCT] as bigint | null | undefined;
        if (productId == null) return;
        await performAsync("CreateLicensesForExistingCustomersWorker", [Number(productId)], {
          delaySeconds: LICENSE_BACKFILL_DELAY_SECONDS,
        });
      },
    },
  ],
});

// RichContent#starts_offering_license_key?: the save that puts the block on a live page its product's buyers have not been offered it on.
function startsOfferingLicenseKey(record: ModelRecord<RichContent>): boolean {
  if (record.get("deleted_at") != null || !hasLicenseKeyIn(record.get("description"))) return false;
  const wasOffering =
    record.attributeBeforeLastSave("deleted_at") == null &&
    record.attributeBeforeLastSave("entity_type") === record.get("entity_type") &&
    record.attributeBeforeLastSave("entity_id") === record.get("entity_id") &&
    hasLicenseKeyIn(record.attributeBeforeLastSave("description"));
  return !wasOffering;
}

// RichContent#owning_product for a page of a product. A page of a version needs the version's category, which no recording covers.
function owningProduct(record: ModelRecord<RichContent>): Link {
  if (record.get("entity_type") !== "Link")
    throw new NotPortedError("The product of a version's page", "app/models/rich_content.rb");
  const entity = associationCache(record).get("entity")?.row;
  if (!entity) throw new NotPortedError("Loading RichContent#entity", "app/models/rich_content.rb");
  return entity as Link;
}

const foreignFileIds = (productId: bigint, ids: number[]) =>
  selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("product_files", "id")} FROM ${table("product_files")} WHERE ${column("product_files", "id")} IN (${Prisma.join(ids)}) AND ${column("product_files", "link_id")} != ${productId}`,
  );

// RichContent#cross_product_file_embed_ids, as the reason a save would be refused, or null.
async function foreignEmbedRefusal(record: ModelRecord<RichContent>, description: unknown[]): Promise<string | null> {
  const ids = embeddedProductFileIds(description as never);
  if (ids.length === 0) return null;
  const foreign = await foreignFileIds(owningProduct(record).id, ids);
  return foreign.length > 0 ? "A RichContent embedding a file of another product" : null;
}

// What a caller that rewrites a page of `product` asks before its first write: null when the validations above would pass, else why
// Rails would reject the description or the port cannot judge it.
export async function descriptionWriteRefusal(product: Link, description: unknown): Promise<string | null> {
  if (!isPlainDescription(description)) return "a description the port does not read";
  if (blockedHrefSchemes(description).length > 0) return "a link with a blocked scheme";
  const ids = embeddedProductFileIds(description);
  if (ids.length === 0) return null;
  return (await foreignFileIds(product.id, ids)).length > 0 ? "a file of another product" : null;
}

export const RichContentDeletable = deletable(RichContents);
