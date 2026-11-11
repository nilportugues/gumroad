// Collaborators::MainController#create, #update and #destroy (app/controllers/collaborators/main_controller.rb): the 404 for an unknown
// or ended collaboration, the sign-in redirect and the policy refusal. The pages are in the page registry.
//
// Handed to Rails whole once the guards pass: the services create or update the collaboration (invitation mail, product links), and
// #destroy soft-deletes it and mails the other side.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { findAliveCollaborator, type CollaboratorRecord } from "../page-props/dashboard/collaborators.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratorPolicy } from "../policies/collaborator.ts";

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

// POST /collaborators: `authorize Collaborator` (the class, so only the admin check applies).
async function create(input: MutationInput): Promise<ActionResult> {
  const redirect = await sellerGuard(guardInput(input), (context) => authorize(collaboratorPolicy.create, context));
  if (redirect !== null) return redirect;
  throw new HandBackToRails("creating a collaboration, which invites the collaborator by mail");
}

// PATCH|PUT /collaborators/:id
async function update(input: MutationInput): Promise<ActionResult> {
  const collaborator = await setCollaborator(input);
  const redirect = await sellerGuard(guardInput(input), (context) =>
    authorize(collaboratorPolicy.update, context, collaborator),
  );
  if (redirect !== null) return redirect;
  throw new HandBackToRails("updating a collaboration, which saves its products and can mail the collaborator");
}

// DELETE /collaborators/:id
async function destroy(input: MutationInput): Promise<ActionResult> {
  const collaborator = await setCollaborator(input);
  const redirect = await sellerGuard(guardInput(input), (context) =>
    authorize(collaboratorPolicy.destroy, context, collaborator),
  );
  if (redirect !== null) return redirect;
  throw new HandBackToRails("ending a collaboration, which soft-deletes it and mails the other side");
}

registerMutations(
  { method: "POST", pattern: "/collaborators", run: create },
  { method: "PATCH", pattern: "/collaborators/:id", run: update },
  { method: "PUT", pattern: "/collaborators/:id", run: update },
  { method: "DELETE", pattern: "/collaborators/:id", run: destroy },
);
