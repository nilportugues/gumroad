// ShipmentsController#mark_as_shipped (app/controllers/shipments_controller.rb): the seller marks an order as shipped from the
// customers page. A purchase without a shipment (old orders) is created in Ruby.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { markShippedBang, shipmentOf, Shipments, VALID_TRACKING_LINK_MESSAGE } from "../models/shipment.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { bit } from "../presenters/product-reads.ts";
import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, noContent, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const IS_PHYSICAL_FLAG = 8;

async function markAsShipped(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null) throw new HandBackToRails("a signed-out request");
  const seller = input.context.currentSeller;

  // set_purchase: current_seller.sales.find_by_external_id(params[:purchase_id]) || e404_json
  const id = decrypt(input.routeParams.purchase_id!);
  const [purchase] =
    id === null
      ? []
      : await selectRows<{ id: bigint; link_id: bigint | null }>(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!purchase) return { ...notFoundJson(), rescued: true };

  const [link] = purchase.link_id === null ? [] : await selectRows<{ flags: bigint | number | null }>(Prisma.sql`SELECT ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${purchase.link_id} LIMIT 1`);
  if (!link) throw new NotPortedError("Audience::PurchasePolicy#mark_as_shipped?", "a purchase without a product");
  const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.markAsShipped, context, bit(link.flags, IS_PHYSICAL_FLAG)));
  if (denied) return denied;

  // `@purchase.shipment || Shipment.new(purchase: @purchase)`
  const shipment = await shipmentOf(purchase);
  if (shipment === null) throw new NotPortedError("Shipment#purchase_requires_shipping", "an order without a shipment");

  // mark_shipped! raises for any other state, after the tracking URL was saved.
  if (shipment.get("ship_state") !== "not_shipped") throw new NotPortedError("Shipment#mark_shipped!", "a shipment that is not in the not_shipped state");
  if ("tracking_url" in input.params) {
    const url = input.params.tracking_url;
    if (url !== null && typeof url !== "string") throw new HandBackToRails("a tracking_url that is not a string");
    shipment.set("tracking_url", url);
  }
  if (!(await Shipments.save(shipment))) {
    // Shipment.human_attribute_name("tracking_url") is "Tracking URL" (ActiveModel would humanize it to "Tracking url").
    const messages = shipment.errors.fullMessages();
    if (messages.length !== 1 || messages[0] !== `Tracking url ${VALID_TRACKING_LINK_MESSAGE}`) throw new NotPortedError("Shipment#save", "a validation error the port does not model");
    return json({ success: false, message: `Tracking URL ${VALID_TRACKING_LINK_MESSAGE}` }, UNPROCESSABLE_ENTITY);
  }
  await markShippedBang(shipment);
  return noContent();
}

registerMutations({ method: "POST", pattern: "/shipments/:purchase_id/mark_as_shipped", format: "json", run: markAsShipped });
