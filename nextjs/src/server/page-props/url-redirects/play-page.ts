// UrlRedirectsController#play (GET /d/:id/play): the access gate, require_product_build_player, the player grant that lets the
// build's frame load its files, and the after_action that counts the visit. The files themselves are served by
// controllers/product-build-player-files.ts under that grant.
import { db } from "../../../lib/db.ts";
import { issuePlayerGrant } from "../../auth/player-grant.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { markRentalAsViewed } from "../../controllers/url-redirects/streaming.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { domainConfig } from "../domain.ts";

import { decideAccess } from "./download-gate.ts";
import { buildGateInput, registerDownload } from "./download-page.ts";
import { load, present, type Loaded } from "./unavailable.ts";

const PLAY_PATH = /^\/d\/([^/.]+)\/play$/u;
export const PLAY_STATE_KEY = "playPageProps";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// #require_product_build_player: a redirect without a purchase or product, a seller without the feature, or a product without a
// live build has no player.
async function requireProductBuildPlayer({ purchase, product }: Loaded): Promise<void> {
  if (purchase === null || product === null || product.user_id === null) throw new RoutingError("Not Found");
  if (!(await isFeatureEnabled("product_build_player", userActor(product.user_id))))
    throw new RoutingError("Not Found");
  if ((await db.productBuild.count({ where: { product_id: product.id, status: "live" } })) === 0)
    throw new RoutingError("Not Found");
}

export async function playFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const match = PLAY_PATH.exec(chain.request.path);
  if (match === null) throw new RoutingError("Not Found");
  const token = safeDecode(match[1]!);
  const loaded = await load(token);
  // sign_in_mobile_app_viewer needs doorkeeper.
  if (present(queryParam(chain.request, "access_token"))) throw new HandBackToRails("a mobile app token");

  const { gate } = await buildGateInput(chain, loaded, { destination: "play", isPoll: false });
  const decision = decideAccess(gate);
  if (decision.kind === "notFound") throw new RoutingError("Not Found");
  if (decision.kind === "redirect") return { halt: { status: 302, location: decision.location, rescued: true } };

  await requireProductBuildPlayer(loaded);
  const { redirect } = loaded;
  const purchase = loaded.purchase!;
  const product = loaded.product!;
  // `.first` of the live builds whose site is unpacked.
  const build = await db.productBuild.findFirst({
    where: { product_id: product.id, status: "live", site_unpacked_at: { not: null } },
    orderBy: { id: "asc" },
  });
  if (build === null) throw new RoutingError("Not Found");
  await markRentalAsViewed(loaded, chain.now);
  const grant = issuePlayerGrant(
    {
      token: redirect.token,
      purchase_id: Number(purchase.id),
      seller_id: Number(product.user_id),
      site_prefix: `builds/${build.product_id}/${build.number}/site`,
    },
    { now: chain.now },
  );
  const config = domainConfig(process.env);
  await registerDownload(redirect, chain);
  return {
    state: {
      [PLAY_STATE_KEY]: {
        title: product.name,
        frame_url: `${chain.request.path.replace(/\/$/u, "")}/${grant}/`,
        content_page_url: `${config.protocol}://${config.domain}/d/${redirect.token}`,
      },
    },
  };
}
