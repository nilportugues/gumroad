// Collaborators::IncomingsController#accept, #decline and #destroy (app/controllers/collaborators/incomings_controller.rb): the 404s,
// the sign-in redirect and the policy refusal. #index is the `/collaborators/incomings` page in the page registry.
//
// Handed to Rails whole once the guards pass: all three writes enqueue an AffiliateMailer job
// (accept! destroys the invitation; decline! and destroy soft-delete the collaboration and clear is_collab on its products).
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import {
  findAliveCollaborator,
  hasCollaboratorInvitation,
  type CollaboratorRecord,
} from "../page-props/dashboard/collaborators.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratorInvitationPolicy, collaboratorPolicy } from "../policies/collaborator.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// `prepend_before_action :set_collaborator` runs ahead of the sign-in check, so a signed-out visitor gets the 404 too.
async function setCollaborator(input: MutationInput): Promise<CollaboratorRecord> {
  const id = decrypt(input.routeParams.id!);
  const collaborator = id === null ? null : await findAliveCollaborator(id);
  if (collaborator === null) throw new RoutingError("Not Found");
  return collaborator;
}

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

// `set_invitation!` runs after the sign-in check and before the action's own `authorize`.
function answerInvitation(query: "accept" | "decline", reason: string) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const collaborator = await setCollaborator(input);
    const redirect = await sellerGuard(guardInput(input), async (sellerContext) => {
      if (!(await hasCollaboratorInvitation(collaborator.id))) throw new RoutingError("Not Found");
      authorize(collaboratorInvitationPolicy[query], sellerContext, collaborator);
    });
    if (redirect !== null) return redirect;
    throw new HandBackToRails(reason);
  };
}

// `authorize_user` authorizes the collaboration itself.
async function destroy(input: MutationInput): Promise<ActionResult> {
  const collaborator = await setCollaborator(input);
  const redirect = await sellerGuard(guardInput(input), (sellerContext) =>
    authorize(collaboratorPolicy.destroy, sellerContext, collaborator),
  );
  if (redirect !== null) return redirect;
  throw new HandBackToRails("ending a collaboration, which soft-deletes it and mails the other side");
}

registerMutations(
  {
    method: "POST",
    pattern: "/collaborators/incomings/:id/accept",
    run: answerInvitation("accept", "accepting an invitation, which mails the inviter"),
  },
  {
    method: "POST",
    pattern: "/collaborators/incomings/:id/decline",
    run: answerInvitation("decline", "declining an invitation, which mails the inviter"),
  },
  { method: "DELETE", pattern: "/collaborators/incomings/:id", run: destroy },
);
