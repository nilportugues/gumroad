// Integrations::CircleController: the seller's setup calls for the Circle integration, as JSON. Each action answers `{ success: false }`
// without asking Circle when an API key (or community) is missing; a request that carries them calls the Circle API and stays with Rails.
import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { isPresent } from "./rails-request.ts";

// `params[name].blank?` for a value Node can compare as Rails does; a list or hash hands back.
function blankParam(input: MutationInput, name: string): boolean {
  const value = input.params[name];
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  return !isPresent(value);
}

// `before_action :skip_authorization`: no policy to answer for.
const circle =
  (required: string[]) =>
  (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      () => {
        // `||` in Rails short-circuits left to right, but every operand is only read, so checking all of them is the same.
        if (required.map((name) => blankParam(input, name)).some(Boolean))
          return Promise.resolve(jsonResponse({ success: false }, 200, true));
        throw new HandBackToRails("a request that calls the Circle API");
      },
    );

registerMutations(
  {
    method: "GET",
    pattern: "/integrations/circle/communities",
    json: true,
    skipForgeryProtection: true,
    run: circle(["api_key"]),
  },
  {
    method: "GET",
    pattern: "/integrations/circle/space_groups",
    json: true,
    skipForgeryProtection: true,
    run: circle(["community_id", "api_key"]),
  },
  {
    method: "GET",
    pattern: "/integrations/circle/communities_and_space_groups",
    json: true,
    skipForgeryProtection: true,
    run: circle(["community_id", "api_key"]),
  },
);
