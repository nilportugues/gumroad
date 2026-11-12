// The access gate of UrlRedirectsController's delivery actions (show, stream, read, play, hls_playlist, download_archive,
// download_product_files, download_subtitle_file, subtitle_file_vtt, smil): the redirects and 404s that check_permissions and
// require_seller_for_test_purchase answer before the action runs. Everything past the gate signs an S3 or CloudFront URL, builds
// a playlist or presenter props, or writes (rental stamp, use count, consumption event), so a request that passes goes to Rails
// untouched (except the actions in SERVED_BY_NODE). Nothing here writes, which is what makes that hand-back safe.
import { railsLoggedInUser } from "../../auth/resolve.ts";
import {
  HandBackToRails,
  RoutingError,
  processAction,
  type ActionResult,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { assertFlatQuery, requestFormat } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { urlRedirectsAction } from "../../controllers/url-redirects/deliveries.ts";

import { decideAccess } from "./download-gate.ts";
import { buildGateInput } from "./download-page.ts";
import { load, present } from "./unavailable.ts";

export type DeliveryAction =
  | "show"
  | "stream"
  | "read"
  | "play"
  | "hls_playlist"
  | "download_archive"
  | "download_product_files"
  | "download_subtitle_file"
  | "subtitle_file_vtt"
  | "smil";

// The route's segments. `.` never appears in one, as in Rails, where it starts the format.
const SEGMENT = "([^/.]+)";
const PATHS: Record<DeliveryAction, RegExp> = {
  show: new RegExp(`^/r/${SEGMENT}$`, "u"),
  download_product_files: new RegExp(`^/r/${SEGMENT}/product_files$`, "u"),
  download_archive: new RegExp(`^/zip/${SEGMENT}$`, "u"),
  stream: new RegExp(`^/s/${SEGMENT}(?:/${SEGMENT})?$`, "u"),
  read: new RegExp(`^/read/${SEGMENT}(?:/${SEGMENT})?$`, "u"),
  play: new RegExp(`^/d/${SEGMENT}/play$`, "u"),
  hls_playlist: new RegExp(`^/r/${SEGMENT}/${SEGMENT}/index\\.m3u8$`, "u"),
  smil: new RegExp(`^/r/${SEGMENT}/${SEGMENT}/stream\\.smil$`, "u"),
  download_subtitle_file: new RegExp(`^/r/${SEGMENT}/${SEGMENT}/${SEGMENT}$`, "u"),
  subtitle_file_vtt: new RegExp(`^/r/${SEGMENT}/${SEGMENT}/${SEGMENT}/captions\\.vtt$`, "u"),
};

// check_permissions is not a before_action of smil, whose only gate is require_seller_for_test_purchase.
const CHECKS_PERMISSIONS = (action: DeliveryAction) => action !== "smil";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// rescue_from ActionController::RoutingError: a `read` that cannot be shown goes to the library, or the home page when signed out.
const readFallback = (signedIn: boolean): FilterOutcome => ({
  halt: { status: 302, location: signedIn ? "/library" : "/", rescued: true },
});

// `e404` answers a format-specific error page; only the HTML one is reproduced.
function notFound(chain: Chain): never {
  if (requestFormat(chain.request) !== "html") throw new HandBackToRails("a 404 for a non-HTML format");
  throw new RoutingError("Not Found");
}

function rescuedNotFound(): never {
  throw new RoutingError("Not Found");
}

export function deliveryFilters(action: DeliveryAction) {
  return async (chain: Chain): Promise<FilterOutcome> => {
    assertFlatQuery(chain.request.queryString);
    const segment = PATHS[action].exec(chain.request.path)?.[1];
    if (segment === undefined) throw new RoutingError("Not Found");
    const token = safeDecode(segment);

    let outcome: FilterOutcome;
    try {
      outcome = await gate(action, token, chain);
    } catch (error) {
      if (action === "read" && error instanceof RoutingError)
        return readFallback(railsLoggedInUser(chain.auth.context) !== null);
      throw error;
    }
    if ("halt" in outcome) return outcome;
    throw new HandBackToRails(`${action} past the access gate`);
  };
}

async function gate(action: DeliveryAction, token: string, chain: Chain): Promise<FilterOutcome> {
  const loaded = await load(token);
  const { purchase } = loaded;
  // sign_in_mobile_app_viewer needs doorkeeper.
  if (present(queryParam(chain.request, "access_token"))) throw new HandBackToRails("a mobile app token");

  const { gate: input } = await buildGateInput(chain, loaded, { destination: action, isPoll: false });
  if (CHECKS_PERMISSIONS(action)) {
    const decision = decideAccess(input);
    if (decision.kind === "redirect") return { halt: { status: 302, location: decision.location, rescued: true } };
    // A `read` 404 is rescued into a redirect, whatever the format.
    if (decision.kind === "notFound") return action === "read" ? rescuedNotFound() : notFound(chain);
  } else if (input.purchase?.isTestPurchase) {
    // require_seller_for_test_purchase: the seller's own purchase is only theirs, or a team member's, to open.
    const { viewer } = input;
    const viewsTest = viewer !== null && (input.purchase.purchaserId === viewer.id || viewer.isTeamMember);
    if (!viewsTest) return notFound(chain);
  }

  // require_product_build_player: a redirect without a purchase has no player. The flag, the live build and the grant are Rails'.
  if (action === "play" && purchase === null) return notFound(chain);
  return { state: {} };
}

// Actions controllers/url-redirects/deliveries.ts carries past the gate (it runs the same before_actions itself), so they skip
// deliveryFilters. The rest stop at the gate and go to Rails.
const SERVED_BY_NODE = new Set<DeliveryAction>(["show", "download_product_files", "download_archive", "hls_playlist", "smil", "download_subtitle_file", "subtitle_file_vtt"]);

export function deliveryResponse(incoming: Request, action: DeliveryAction): Promise<Response> {
  if (SERVED_BY_NODE.has(action)) return processAction(incoming, {}, urlRedirectsAction);
  return processAction(incoming, { filters: deliveryFilters(action) }, (): Promise<ActionResult> => {
    throw new HandBackToRails(`${action} past the access gate`);
  });
}
