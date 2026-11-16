// app/models/utm_link_visit.rb for the attribution job's write: validations in the order Rails declares them and PaperTrail.
import type { UtmLinkVisit } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";

export const UTM_LINK: BelongsTo = {
  name: "utm_link",
  foreignKey: "utm_link_id",
  targetTable: "utm_links",
  targetModel: "UtmLink",
};
const paperTrail = hasPaperTrail<UtmLinkVisit>("UtmLinkVisit", { itemType: "UtmLinkVisit" });

export const UtmLinkVisits = defineModel<UtmLinkVisit>({
  rubyClass: "UtmLinkVisit",
  prismaModel: "UtmLinkVisit",
  delegate: (tx) => tx.utmLinkVisit as never,
  validations: [
    belongsToRequired<UtmLinkVisit>(UTM_LINK),
    validatesPresenceOf<UtmLinkVisit>(["ip_address"]),
    validatesPresenceOf<UtmLinkVisit>(["browser_guid"]),
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});
