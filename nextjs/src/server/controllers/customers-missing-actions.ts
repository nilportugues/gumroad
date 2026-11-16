// config/routes.rb still maps GET /customers/sales, POST /customers/import and POST /customers/import_manually_entered_emails to
// CustomersController actions that no longer exist. Rails raises ActionNotFound before any callback runs (no authorization, no CSRF check),
// so every visitor gets the public 404.
import { type ActionResult, RoutingError } from "./application-controller.ts";
import { registerMutations } from "./mutation.ts";

export async function missingAction(): Promise<ActionResult> {
  throw new RoutingError("Not Found");
}

registerMutations(
  { method: "GET", pattern: "/customers/sales", skipForgeryProtection: true, run: missingAction },
  { method: "POST", pattern: "/customers/import", skipForgeryProtection: true, run: missingAction },
  { method: "POST", pattern: "/customers/import_manually_entered_emails", skipForgeryProtection: true, run: missingAction },
);
