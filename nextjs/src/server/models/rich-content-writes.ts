// Port of app/models/rich_content.rb for DeleteProductRichContentWorker: has_paper_trail, the entity presence and description schema
// validations and the soft delete. A save that changes the description (its two extra validations) or leaves the page alive (the
// license backfill) is not ported; nothing here reaches either.
import type { RichContent } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { associationCache } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { NotPortedError } from "./user.ts";

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
      name: "embedded_files_belong_to_product, link_hrefs_use_permitted_schemes",
      run(record) {
        if (record.attributeChanged("description")) {
          throw new NotPortedError("RichContent description validations", "app/models/rich_content.rb");
        }
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
  afterCommit: [
    {
      name: "enqueue_license_backfill",
      on: ["create", "update"],
      run(record: ModelRecord<RichContent>) {
        // starts_offering_license_key? is false for a page that is deleted.
        if (record.get("deleted_at") == null)
          throw new NotPortedError("RichContent#enqueue_license_backfill", "app/models/rich_content.rb");
      },
    },
  ],
});

export const RichContentDeletable = deletable(RichContents);
