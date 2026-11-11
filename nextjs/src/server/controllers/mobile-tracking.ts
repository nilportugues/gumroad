// Products::MobileTrackingController#show (app/controllers/products/mobile_tracking_controller.rb): the page the apps embed to fire a
// product's analytics events.
//
// Ported: the 404 of a product that does not exist or was deleted. A live product renders an ERB page (the props in a meta tag and the
// `mobile_tracking` Vite entry, with the seller's analytics settings behind `analytics_enabled?`) that Node has no shell for, so it
// goes to Rails whole.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// `Link.fetch(params[:link_id]) || e404`
async function show(input: MutationInput): Promise<ActionResult> {
  const permalink = input.routeParams.link_id;
  const [product] = permalink
    ? await selectRows(
        Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
      )
    : [];
  if (!product) throw new RoutingError("Not Found");
  throw new HandBackToRails("the tracking page is an ERB view");
}

registerMutations({ method: "GET", pattern: "/links/:link_id/in_app", skipForgeryProtection: true, run: show });
