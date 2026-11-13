// Port of UrlRedirectsController#download_page (GET /d/:id): the before_actions that gate it, the
// props UrlRedirectPresenter#download_page_with_content_props builds, and the after_actions that record
// the visit. A content page is rendered here for a product without versions or for the one version a purchase bought: the
// provider's own files (download-files.ts), its rich content pages and the files they embed, the license key, the posts
// (download-posts.ts) and the background polls. SKUs, several or shared versions, integrations, communities and third-party analytics hand back to Rails, as do the mobile app token sign-in and
// bundle redirects. A saved content page is echoed as last_content_page_id; a coffee product redirects to the seller's coffee page.
import { Prisma, type Link, type Purchase, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { readEncryptedCookie, writeEncryptedCookie } from "../../auth/rails-cookies.ts";
import { railsCookieSecrets } from "../../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { setCookieHeader } from "../../controllers/rack-cookies.ts";
import { assertFlatQuery, cgiEscape } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { aliveProductFiles, contentProvider, type ContentProvider } from "../../controllers/url-redirects/files.ts";
import { getConfig } from "../../infra/config.ts";
import { truncateToSeconds } from "../../models/concerns/ruby-time.ts";
import { createEventBang } from "../../models/consumption-event.ts";
import { LinkFlags } from "../../models/link.ts";
import { isListenable } from "../../models/product-file.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { UserFlags } from "../../models/user.ts";
import { parseJsonData } from "../../models/with-filtering.ts";
import { subdomainWithProtocol } from "../../presenters/product.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { remoteIp } from "../audience/events.ts";
import { domainConfig, type DomainConfig } from "../domain.ts";
import type { MetaTagBuilder } from "../meta-tags.ts";
import { setFaviconMetaTags } from "../storefront/post.ts";

import { contentItems, mediaLocationForDownloadPage } from "./download-files.ts";
import { decideAccess, type GateInput } from "./download-gate.ts";
import { downloadPosts } from "./download-posts.ts";
import {
  embeddedFileIds,
  hasPostsNode,
  productRichPages,
  richContentPagesJson,
  variantRichPages,
} from "./download-rich-content.ts";
import { latestMediaLocations } from "./media-locations.ts";
import { claimBySeller, layoutProps, load, present, type Loaded } from "./unavailable.ts";

const DOWNLOAD_PATH = /^\/d\/([^/.]+)$/u;
const COOKIE_NAME = "confirmed_redirect";
const COMPONENT = "UrlRedirects/DownloadPage";
export const POLL_STATE_KEY = "download_page_poll_props";
const POLLED_PROPS = ["audio_durations", "latest_media_locations"];
const DEFAULT_IOS_APP_ID = "916819108";
const DEFAULT_ANDROID_BUNDLE_ID = "com.gumroad.app";
const HAS_BEEN_SEEN_BIT = 1;
// Rails unescapes the route segment before it reaches params[:id].
const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// download_page_polling_request?
export function isPollingRequest(headers: Headers): boolean {
  if (headers.get("x-inertia") !== "true" || headers.get("x-inertia-partial-component") !== COMPONENT) return false;
  const requested = (headers.get("x-inertia-partial-data") ?? "").split(",");
  return requested.join("") !== "" && requested.every((name) => POLLED_PROPS.includes(name));
}

type Download = { loaded: Loaded; product: Link; seller: User };

// Everything the page would list that Node does not render; checked before any write so a hand-back never
// follows a recorded visit.
async function assertRenderable(loaded: Loaded): Promise<Download> {
  const { product } = loaded;
  if (!product) throw new HandBackToRails("a redirect without a product");
  const seller = await db.user.findUnique({ where: { id: product.user_id! } });
  if (!seller) throw new HandBackToRails("a product without a seller");

  if (LinkFlags.isSet(product.flags, "community_chat_enabled")) throw new HandBackToRails("community chat");
  if (
    present(seller.google_analytics_id) ||
    present(seller.facebook_pixel_id) ||
    (seller.json_data ?? "").includes("tiktok_pixel_id")
  )
    throw new HandBackToRails("seller analytics");

  if ((await db.productIntegration.count({ where: { product_id: product.id, deleted_at: null } })) > 0)
    throw new HandBackToRails("integrations");
  if (
    (await db.thirdPartyAnalytic.count({
      where: { deleted_at: null, OR: [{ link_id: Number(product.id) }, { user_id: Number(seller.id) }] },
    })) > 0
  )
    throw new HandBackToRails("third-party analytics");
  return { loaded, product, seller };
}

// UrlRedirectPresenter#license for a product without versions, where Purchase#uses_license_key? is is_licensed alone; a
// version's key also depends on whether its pages print one.
async function licenseProps(purchase: Purchase | null, product: Link, provider: ContentProvider) {
  if (!purchase || !LinkFlags.isSet(product.flags, "is_licensed")) return null;
  if (provider.kind === "variant") throw new HandBackToRails("the license key of a version");
  const licenses = await db.license.findMany({ where: { purchase_id: Number(purchase.id) }, orderBy: { id: "asc" } });
  // has_one :license takes an unspecified row when there are several.
  if (licenses.length > 1) throw new HandBackToRails("a purchase with several licenses");
  const serial = licenses[0]?.serial;
  if (serial === undefined || serial === null) return null;
  return {
    license_key: serial,
    is_multiseat_license: PurchaseFlags.isSet(purchase.flags, "is_multiseat_license"),
    seats: purchase.quantity,
  };
}

// Purchase#last_content_page_id: json_data_for_attr, nil unless the stored value is present?.
export function lastContentPageId(jsonData: string | null): string | null {
  const value = parseJsonData(jsonData).last_content_page_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HandBackToRails("a saved content page that is not a string");
  return value.trim() === "" ? null : value;
}

// !Subscription#grant_access_to_product?
export async function membershipInactive(
  { subscription, product }: Pick<Loaded, "subscription" | "product">,
  now: Date,
): Promise<boolean> {
  if (!subscription) return false;
  const { cancelled_at: cancelledAt, failed_at: failedAt, ended_at: endedAt } = subscription;
  if (SubscriptionFlags.isSet(subscription.flags, "is_installment_plan"))
    return cancelledAt !== null || failedAt !== null;
  if (failedAt === null && endedAt === null && (cancelledAt === null || cancelledAt.getTime() > now.getTime()))
    return false;
  const link =
    subscription.link_id === null || subscription.link_id === product?.id
      ? product
      : await db.link.findUnique({ where: { id: subscription.link_id } });
  return !link || LinkFlags.isSet(link.flags, "block_access_after_membership_cancellation");
}

// viewer_owns_subscription?: gift-origin subscriptions get no bypass, and the gift lookup runs last.
export async function viewerOwnsSubscription(
  { purchase, subscription }: Loaded,
  viewer: User | null,
): Promise<boolean> {
  if (!purchase || !subscription || !viewer || PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase"))
    return false;
  if (subscription.user_id === null || subscription.user_id !== viewer.id) return false;
  const originals = await db.purchase.findMany({
    where: { subscription_id: subscription.id },
    orderBy: { id: "asc" },
    select: { id: true, flags: true },
  });
  const original = originals.find((row) => PurchaseFlags.isSet(row.flags, "is_original_subscription_purchase"));
  return original ? (await db.gift.count({ where: { gifter_purchase_id: original.id } })) === 0 : true;
}

const richPagesOf = (provider: ContentProvider, product: Link) =>
  provider.kind === "variant" ? variantRichPages(provider.variant.id) : productRichPages(product.id);

const downloadUrl = (config: DomainConfig, token: string) => `${config.protocol}://${config.domain}/d/${token}`;

// UrlRedirectsController#download_page's props, in the order Rails merges them. The optional
// audio_durations and latest_media_locations are left out, as in a first load.
export async function downloadPageProps(
  token: string,
  { loggedInUser, display, now }: { loggedInUser: User | null; display: string | null; now: Date },
) {
  const loaded = await load(token);
  const { purchase } = loaded;
  const { product, seller } = await assertRenderable(loaded);

  let addToLibraryOption = "none";
  if (purchase && !loaded.purchaser && !claimBySeller(loaded, loggedInUser))
    addToLibraryOption = loggedInUser ? "add_to_library_button" : "signup_form";

  const provider = await contentProvider(loaded);
  const pages = await richPagesOf(provider, product);
  // The seller's own view of a page with video asks whether it was transcoded.
  if (pages.length > 0 && loggedInUser?.id === product.user_id) {
    if (provider.kind === "variant") throw new HandBackToRails("the seller's view of the pages of a version");
    if ((await db.productFile.count({ where: { link_id: product.id, deleted_at: null, filegroup: "video" } })) > 0)
      throw new HandBackToRails("the transcoding notice of a page with video");
  }

  return {
    content: {
      license: await licenseProps(purchase, product, provider),
      content_items: await contentItems(loaded, loggedInUser, embeddedFileIds(pages)),
      bundle_products: [],
      rich_content_pages:
        pages.length > 0
          ? richContentPagesJson(pages, provider.kind === "variant" ? encrypt(provider.variant.id) : null)
          : null,
      last_content_page_id: purchase ? lastContentPageId(purchase.json_data) : null,
      posts: pages.length > 0 && !hasPostsNode(pages) ? [] : await downloadPosts(purchase, product, seller),
      video_transcoding_info: null,
      custom_receipt: null,
      discord: null,
      community_chat_url: null,
      ios_app_url: `https://itunes.apple.com/app/id${getConfig("IOS_APP_ID", DEFAULT_IOS_APP_ID)}`,
      android_app_url: `https://play.google.com/store/apps/details?id=${getConfig("ANDROID_BUNDLE_ID", DEFAULT_ANDROID_BUNDLE_ID)}`,
      download_all_button: null,
    },
    product_has_third_party_analytics: purchase ? false : null,
    seller_analytics: null,
    ...layoutProps(loaded, false, now),
    is_mobile_app_web_view: display === "mobile_app",
    content_unavailability_reason_code: null,
    add_to_library_option: addToLibraryOption,
    dropbox_api_key: getConfig("DROPBOX_PICKER_API_KEY") ?? null,
  };
}

// #requested_download_page_polling_props: audio_durations and latest_media_locations over alive_product_files.
async function pollProps(loaded: Loaded, requested: string[]): Promise<Record<string, unknown>> {
  const { product, purchase } = loaded;
  const files = product
    ? await aliveProductFiles(loaded, embeddedFileIds(await richPagesOf(await contentProvider(loaded), product)), {
        versions: true,
      })
    : await aliveProductFiles(loaded);
  const props: Record<string, unknown> = {};
  if (requested.includes("audio_durations"))
    props.audio_durations = Object.fromEntries(
      files.filter(({ file }) => isListenable(file)).map(({ file }) => [encrypt(file.id), file.duration]),
    );
  if (requested.includes("latest_media_locations")) {
    const locations = purchase ? await latestMediaLocations(purchase.id) : null;
    props.latest_media_locations =
      locations === null
        ? {}
        : Object.fromEntries(
            files.map(({ file }) => [
              encrypt(file.id),
              mediaLocationForDownloadPage(file, locations.get(file.id) ?? null),
            ]),
          );
  }
  return props;
}

// #set_download_page_meta_tags
export async function setDownloadPageMeta(meta: MetaTagBuilder, token: string, config: DomainConfig) {
  const loaded = await load(token);
  const { product } = loaded;
  const seller = await db.user.findUnique({ where: { id: product!.user_id! } });
  await setFaviconMetaTags(meta, seller!);
  // with_product_files.name: the purchased version's, which falls back to the product's while it is still "Untitled".
  const provider = await contentProvider(loaded);
  if (provider.kind === "variant" && provider.variant.name === null)
    throw new HandBackToRails("a version without a name");
  const versionName = provider.kind === "variant" ? provider.variant.name : null;
  meta.set({ title: versionName === null || versionName === "Untitled" ? product!.name : versionName });
  meta.set({
    name: "apple-itunes-app",
    content: `app-id=${getConfig("IOS_APP_ID", DEFAULT_IOS_APP_ID)}, app-argument=${downloadUrl(config, token)}`,
  });
}

// The after_actions, in the order Rails runs them: the view event, then the use count and seen flag.
async function recordVisit(loaded: Loaded, chain: Chain): Promise<void> {
  const { redirect, purchase } = loaded;
  await createEventBang({
    event_type: "view",
    platform: "web",
    url_redirect_id: redirect.id,
    product_file_id: null,
    purchase_id: redirect.purchase_id,
    product_id: purchase?.link_id ?? redirect.link_id,
    consumed_at: truncateToSeconds(chain.now),
    ip_address: remoteIp(chain.request.headers) ?? "127.0.0.1",
  });
  await registerDownload(redirect, chain);
}

// #register_that_user_has_downloaded_product: the use count, the seen flag and the confirmation cookie.
export async function registerDownload(redirect: Loaded["redirect"], chain: Chain): Promise<void> {
  // increment! leaves updated_at alone; mark_as_seen ORs the bit in so it keeps a concurrent flag write.
  await db.$executeRaw(Prisma.sql`UPDATE url_redirects SET uses = COALESCE(uses, 0) + 1 WHERE id = ${redirect.id}`);
  await db.$executeRaw(
    Prisma.sql`UPDATE url_redirects SET flags = COALESCE(flags, 0) | ${HAS_BEEN_SEEN_BIT}, updated_at = ${chain.now} WHERE id = ${redirect.id}`,
  );
  // Appended to this request's list: the options object is shared across requests.
  chain.afterCookies.push(
    setCookieHeader(COOKIE_NAME, {
      value: writeEncryptedCookie(railsCookieSecrets(), COOKIE_NAME, redirect.token),
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    }),
  );
}

// custom_domain_coffee_url on the seller's subdomain, purchase_email passed through when given (an empty
// value stays, a bare key is nil and drops out).
async function coffeePageUrl(sellerId: bigint | null, purchaseEmail: string | null | undefined): Promise<string> {
  const seller = sellerId === null ? null : await db.user.findUnique({ where: { id: sellerId } });
  const host = seller ? subdomainWithProtocol(seller) : null;
  if (host === null) throw new HandBackToRails("a coffee seller without a subdomain");
  return `${host}/coffee${purchaseEmail === undefined || purchaseEmail === null ? "" : `?purchase_email=${cgiEscape(purchaseEmail)}`}`;
}

// The facts check_permissions reads, for any action that runs it. `destination` is params[:action].
export async function buildGateInput(
  chain: Chain,
  loaded: Loaded,
  { destination, isPoll }: { destination: string; isPoll: boolean },
): Promise<{ gate: GateInput; viewer: User | null }> {
  const { redirect, purchase, product } = loaded;
  const config = domainConfig(process.env);
  const viewer = railsLoggedInUser(chain.auth.context);
  const display = queryParam(chain.request, "display");
  const ownsSubscription = await viewerOwnsSubscription(loaded, viewer);

  const gate: GateInput = {
    token: redirect.token,
    path: chain.request.path,
    fullpath:
      chain.request.queryString === "" ? chain.request.path : `${chain.request.path}?${chain.request.queryString}`,
    display: present(display) ? display : null,
    destination,
    isPoll,
    hasBeenSeen: UrlRedirectFlags.isSet(redirect.flags, "has_been_seen"),
    purchase: purchase
      ? {
          withdrawn:
            purchase.stripe_refunded === true ||
            (purchase.chargeback_date !== null && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed")),
          purchaserId: purchase.purchaser_id,
          rentalExpired: purchase.rental_expired === true,
          accessRevoked: PurchaseFlags.isSet(purchase.flags, "is_access_revoked"),
          isTestPurchase: purchase.purchaser_id !== null && product?.user_id === purchase.purchaser_id,
          ipAddress: purchase.ip_address,
          membershipInactive: await membershipInactive(loaded, chain.now),
        }
      : null,
    viewer: viewer ? { id: viewer.id, isTeamMember: UserFlags.isSet(viewer.flags, "is_team_member") } : null,
    viewerOwnsSubscription: ownsSubscription,
    confirmedCookie:
      readEncryptedCookie(railsCookieSecrets(), COOKIE_NAME, chain.request.cookies.get(COOKIE_NAME) ?? undefined) ===
      redirect.token,
    remoteIp: remoteIp(chain.request.headers),
    loginUrl: (next) => `${config.protocol}://${config.domain}/login?next=${cgiEscape(next)}`,
  };
  return { gate, viewer };
}

export async function downloadPageFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const segment = DOWNLOAD_PATH.exec(chain.request.path)?.[1];
  if (segment === undefined) throw new RoutingError("Not Found");
  const token = safeDecode(segment);
  const loaded = await load(token);
  const { redirect, purchase, product } = loaded;

  // redirect_bundle_purchase_to_library_if_needed and redirect_to_coffee_page_if_needed.
  if (purchase && PurchaseFlags.isSet(purchase.flags, "is_bundle_purchase"))
    throw new HandBackToRails("a bundle purchase");
  if (product?.native_type === "coffee")
    return {
      halt: {
        status: 302,
        location: await coffeePageUrl(product.user_id, queryParam(chain.request, "purchase_email")),
        rescued: true,
      },
    };
  // sign_in_mobile_app_viewer needs doorkeeper.
  if (present(queryParam(chain.request, "access_token"))) throw new HandBackToRails("a mobile app token");

  const isPoll = isPollingRequest(chain.request.headers);
  const { gate, viewer } = await buildGateInput(chain, loaded, { destination: "download_page", isPoll });

  const decision = decideAccess(gate);
  if (decision.kind === "notFound") throw new RoutingError("Not Found");
  if (decision.kind === "redirect") return { halt: { status: 302, location: decision.location, rescued: true } };

  chain.headers.set("x-robots-tag", "noindex");
  // A poll writes nothing: no view event, use count or cookie.
  if (isPoll)
    return {
      state: {
        [POLL_STATE_KEY]: await pollProps(
          loaded,
          (chain.request.headers.get("x-inertia-partial-data") ?? "").split(","),
        ),
      },
    };
  // Build the props once before writing, so a hand-back from them never follows a recorded visit.
  await downloadPageProps(redirect.token, { loggedInUser: viewer, display: gate.display, now: chain.now });
  await recordVisit(loaded, chain);
  return { state: {} };
}
