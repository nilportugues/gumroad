// Collaborators::MainController#create, #update and #destroy (app/controllers/collaborators/main_controller.rb): the 404 for an unknown
// or ended collaboration, the sign-in redirect and the policy refusal. The pages are in the page registry.
//
// #create runs in Node for the shapes models/collaborator-create.ts proves, #destroy in controllers/collaborator-destroy.ts. #update is
// handed to Rails whole once the guards pass: the service saves the collaboration's products and can mail the collaborator.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { createCollaboration, resolveCreation, type RequestedCollaboration } from "../models/collaborator-create.ts";
import { CREATION_MAIL, INVITED_MAIL, deliverCollaboratorMail } from "../models/collaborator-end.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { findAliveCollaborator, type CollaboratorRecord } from "../page-props/dashboard/collaborators.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratorPolicy } from "../policies/collaborator.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { destroyCollaboration } from "./collaborator-destroy.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const SEE_OTHER = 303;
const COLLABORATORS_PATH = "/collaborators";
const NEW_COLLABORATOR_PATH = "/collaborators/new";

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

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// A boolean flag; "false" and "0" would be truthy in Ruby but false for the flag setter, so only real booleans are read.
const flag = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  throw new HandBackToRails("a flag that is not a boolean, which Rails reads two ways");
};
// `value.presence&.to_i` for the digits a form sends; anything else Ruby would cast differently.
const percent = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "string" && /^\d{1,9}$/u.test(value)) return Number(value);
  throw new HandBackToRails("a commission that is not a whole number");
};

// `params.require(:collaborator).permit(:email, :apply_to_all_products, :percent_commission, :dont_show_as_co_creator, products: [...])`
function submitted(input: MutationInput): RequestedCollaboration {
  const body = input.params.collaborator;
  if (!isHash(body) || Object.keys(body).length === 0)
    throw new HandBackToRails("collaborator is missing or not a hash, which params.require turns into a 400");
  if (body.email !== undefined && body.email !== null && typeof body.email !== "string")
    throw new HandBackToRails("an email that is not text");
  let products: RequestedCollaboration["products"] = null;
  if (body.products !== undefined && body.products !== null) {
    if (!Array.isArray(body.products) || !body.products.every(isHash))
      throw new HandBackToRails("products that are not a list of hashes");
    products = body.products.map((product) => {
      if (typeof product.id !== "string") throw new HandBackToRails("a product id that is not text");
      return {
        externalId: product.id,
        percent: percent(product.percent_commission),
        dontShow: flag(product.dont_show_as_co_creator),
      };
    });
  }
  return {
    email: (body.email as string | null | undefined) ?? null,
    applyToAllProducts: flag(body.apply_to_all_products),
    dontShow: flag(body.dont_show_as_co_creator),
    percent: percent(body.percent_commission),
    products,
  };
}

// POST /collaborators: `authorize Collaborator` (the class, so only the admin check applies).
async function create(input: MutationInput): Promise<ActionResult> {
  const redirect = await sellerGuard(guardInput(input), (context) => authorize(collaboratorPolicy.create, context));
  if (redirect !== null) return redirect;
  const resolved = await resolveCreation(input.context.currentSeller!.id, submitted(input));
  if ("blocked" in resolved) throw new HandBackToRails(resolved.blocked);
  if ("message" in resolved)
    return {
      status: FOUND,
      location: NEW_COLLABORATOR_PATH,
      flash: { alert: resolved.message },
      inertiaErrors: { "collaborator.base": resolved.message },
    };
  const id = await createCollaboration(resolved);
  await deliverCollaboratorMail(resolved.invited ? INVITED_MAIL : CREATION_MAIL, id);
  return { status: SEE_OTHER, location: COLLABORATORS_PATH, flash: { notice: "Changes saved!" } };
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
  await destroyCollaboration(input.context.currentSeller!.id, collaborator.id);
  return {
    status: SEE_OTHER,
    location: COLLABORATORS_PATH,
    flash: { notice: "The collaborator was removed successfully." },
  };
}

registerMutations(
  { method: "POST", pattern: "/collaborators", run: create },
  { method: "PATCH", pattern: "/collaborators/:id", run: update },
  { method: "PUT", pattern: "/collaborators/:id", run: update },
  { method: "DELETE", pattern: "/collaborators/:id", run: destroy },
);
