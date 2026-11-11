// Port of app/models/subtitle_file.rb for SubtitleFileSizeWorker: the required product file and url, the subtitle type check for a
// file that is not deleted, and has_paper_trail. `serialize :json_data` defines a `json_data` attribute although the table has no such
// column, so it is a nil attribute that PaperTrail's `object` lists right after the ones the caller assigned (see `loadSubtitleFile`).
import type { SubtitleFile } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";

// SubtitleFile::VALID_FILE_TYPE_REGEX, `/\A.+\.(srt|sub|sbv|vtt)\z/`: `.` does not match a newline, and `\z` is the very end.
const VALID_FILE_TYPE = /^[^\n]+\.(?:srt|sub|sbv|vtt)$/u;
const UNSUPPORTED_TYPE_MESSAGE =
  "Subtitle type not supported. Please upload only subtitles with extension .srt, .sub, .sbv, or .vtt.";

const PRODUCT_FILE: BelongsTo = {
  name: "product_file",
  foreignKey: "product_file_id",
  targetTable: "product_files",
  targetModel: "ProductFile",
};

const paperTrail = hasPaperTrail<SubtitleFile>("SubtitleFile", { itemType: "SubtitleFile" });

export const SubtitleFiles = defineModel<SubtitleFile>({
  rubyClass: "SubtitleFile",
  prismaModel: "SubtitleFile",
  delegate: (tx) => tx.subtitleFile as never,
  validations: [
    validatesAssociationPresence<SubtitleFile>(PRODUCT_FILE),
    validatesPresenceOf<SubtitleFile>(["url"]),
    {
      name: "ensure_valid_file_type",
      run(record) {
        if (record.get("deleted_at") != null) return;
        if (!VALID_FILE_TYPE.test(record.get("url") ?? "")) record.errors.add("base", UNSUPPORTED_TYPE_MESSAGE);
      },
    },
  ],
  afterUpdate: [...paperTrail.afterUpdate],
  afterCreate: [...paperTrail.afterCreate],
});

// The row as Rails materializes it: the virtual `json_data` attribute comes before the table's columns.
export const loadSubtitleFile = (row: SubtitleFile) => SubtitleFiles.load({ json_data: null, ...row } as SubtitleFile);
