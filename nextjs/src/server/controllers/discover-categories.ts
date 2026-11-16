// GET /discover/categories: routes.rb names `discover#categories`, which DiscoverController does not define, so every request is an
// AbstractController::ActionNotFound (a 404) before any filter runs.
import { railsLoggedInUser } from "../auth/resolve.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// Node's chain seeds a signed-in seller's dashboard nav items before the action; Rails raises before its filters, so it would not.
function categories({ context }: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(context))
    throw new HandBackToRails("a signed-in visitor, whose nav items Rails does not seed here");
  return Promise.reject(new RoutingError("Not Found"));
}

registerMutations({ method: "GET", pattern: "/discover/categories", skipForgeryProtection: true, run: categories });
