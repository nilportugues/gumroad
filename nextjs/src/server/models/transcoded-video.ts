// app/models/transcoded_video.rb for ExpireTranscodedVideosJob: the presence and state validations, the last_accessed_at default,
// has_paper_trail and the soft delete. The streamable's is_transcoded_for_hls update that TranscodedVideo#mark_deleted! follows
// with is not ported; the job hands back before it.
import type { TranscodedVideo } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";

// The states of the state_machine; state_machines-activerecord adds a validation that rejects any other, nil included.
const STATES = ["processing", "completed", "error"];
// product_file_id is in self.ignored_columns: callers load the row without it, so it stays out of the version's `object`.
const paperTrail = hasPaperTrail<TranscodedVideo>("TranscodedVideo", { itemType: "TranscodedVideo" });

export const TranscodedVideos = defineModel<TranscodedVideo>({
  rubyClass: "TranscodedVideo",
  prismaModel: "TranscodedVideo",
  delegate: (tx) => tx.transcodedVideo as never,
  validations: [
    validatesPresenceOf<TranscodedVideo>(["original_video_key", "transcoded_video_key"]),
    {
      name: "state_machine state validation",
      run(record) {
        if (!STATES.includes(record.get("state")!)) record.errors.add("state", "invalid");
      },
    },
  ],
  beforeSave: [
    {
      name: "assign_default_last_accessed_at",
      run(record) {
        // `||=` assigns nothing when the column is set, and a plain read leaves PaperTrail's attribute order alone.
        if (record.get("last_accessed_at") == null) record.set("last_accessed_at", new Date());
      },
    },
  ],
  afterUpdate: [...paperTrail.afterUpdate],
  afterCreate: [...paperTrail.afterCreate],
});

export const TranscodedVideoDeletable = deletable(TranscodedVideos);
