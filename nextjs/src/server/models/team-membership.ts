// Port of app/models/team_membership.rb for the one write a controller makes: `update!(last_accessed_at:)` when a seller switches
// account. The validations (the owner membership rules) read rows and pass for any membership the app created; they are not ported.
import type { TeamMembership } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { defineModel } from "./runtime/define-model.ts";

const paperTrail = hasPaperTrail<TeamMembership>("TeamMembership", { itemType: "TeamMembership" });

export const TeamMemberships = defineModel<TeamMembership>({
  rubyClass: "TeamMembership",
  prismaModel: "TeamMembership",
  delegate: (tx) => tx.teamMembership as never,
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});
