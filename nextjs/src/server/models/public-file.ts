// Port of app/models/public_file.rb for DeleteUnusedPublicFilesJob: the validations that `mark_deleted!` runs and the soft delete.
// The before_validation callbacks that fill a blank column (display name, public id, file type and group) are not ported;
// `unportedCallbackReason` names the rows they would change, and the job hands those back.
import type { PublicFile } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank, validatesFormatOf, validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";

// `/\A[a-z0-9]{16}\z/`
const PUBLIC_ID_FORMAT = /^[a-z0-9]{16}$/u;

// The resource types the rows carry in practice; any other class needs its own model to load the target.
const RESOURCES: Record<string, BelongsTo> = {
  Link: { name: "resource", foreignKey: "resource_id", targetTable: "links", targetModel: "Link" },
  User: { name: "resource", foreignKey: "resource_id", targetTable: "users", targetModel: "User" },
};

export function resourceKnown(file: PublicFile): boolean {
  return file.resource_type in RESOURCES;
}

// The columns before_validation fills when they are blank or nil, which the soft delete would then write.
export function unportedCallbackReason(file: PublicFile, attached: boolean): string | null {
  if (isBlank(file.public_id)) return "a public file without a public id";
  if (isBlank(file.display_name) && attached) return "a public file with a blank display name and an attached file";
  if (!isBlank(file.original_file_name) && (file.file_type === null || file.file_group === null))
    return "a public file without a file type or group";
  return null;
}

export const PublicFiles = defineModel<PublicFile>({
  rubyClass: "PublicFile",
  prismaModel: "PublicFile",
  delegate: (tx) => tx.publicFile as never,
  validations: [
    {
      name: "belongs_to :resource (required)",
      async run(record, ctx) {
        const association = RESOURCES[record.get("resource_type")];
        if (!association) throw new Error(`PublicFile resource type ${record.get("resource_type")} is not ported`);
        if ((await loadBelongsTo(record, association, ctx)) === null) record.errors.add("resource", "required");
      },
    },
    validatesPresenceOf<PublicFile>(["public_id"]),
    validatesFormatOf<PublicFile>(["public_id"], { with: PUBLIC_ID_FORMAT }),
    validatesUniquenessOf<PublicFile>("public_files", ["public_id"], {}),
    validatesPresenceOf<PublicFile>(["original_file_name"]),
    validatesPresenceOf<PublicFile>(["display_name"]),
  ],
});

export const PublicFileDeletable = deletable(PublicFiles);
