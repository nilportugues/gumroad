// Settings::Profile::ProductsController#show (app/controllers/settings/profile/products_controller.rb): the product card the profile
// editor loads, `ProductPresenter#product_props` for the seller's own product rendered as a visitor sees it (no pundit_user, so
// `can_edit` is false and the seller's wishlists are left out).
//
// Whatever ProductProps cannot prove (an upload's URL, a purchase of this browser's guid, an offer code it cannot weigh) is handed to
// Rails whole, before anything is written. The one write it can make, the reputation snapshot's refresh job, is pushed last.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";
import { productProps } from "../presenters/product-props.ts";
import { findLink, findUserById } from "../presenters/product-reads.ts";

import { RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { remoteIp as mutationRemoteIp } from "./mutation.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json } from "./seller-json.ts";

const GUID_COOKIE = "_gumroad_guid";

async function show(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (sellerContext) => {
      // `current_seller.products.find_by_external_id!(params[:id])`
      const id = decrypt(input.routeParams.id ?? "");
      const product = id === null ? null : await findLink(id);
      if (product === null || product.user_id !== input.context.currentSeller!.id) throw new RoutingError("Not Found");
      const denied = await authorizeJson(input, () => authorize(linkPolicy.new, sellerContext));
      if (denied) return denied;

      const seller = (await findUserById(product.user_id))!;
      const afterRender: (() => Promise<void>)[] = [];
      const ip = mutationRemoteIp(input.request);
      const props = await productProps(product, seller, {
        user: null,
        context: null,
        remoteIp: ip,
        // ApplicationController#incoming_browser_guid ignores a guid minted for this response, which the request does not carry.
        browserGuid: input.request.cookies.get(GUID_COOKIE) ?? null,
        quantity: 1,
        discountCode: null,
        purchaseId: null,
        purchaseEmailDigest: null,
        recommendedBy: null,
        sellerCustomDomainUrl: null,
        request: {
          host: input.request.host,
          hostWithPort: input.request.hostWithPort,
          protocol: input.request.protocol,
          remoteIp: ip ?? "",
          params: {},
          cookies: new Map(),
        },
        afterRender,
      });
      for (const effect of afterRender) await effect();
      return json(props);
    },
    { paramsRead: true },
  );
}

registerMutations({ method: "GET", pattern: "/profile/products/:id", skipForgeryProtection: true, run: show });
