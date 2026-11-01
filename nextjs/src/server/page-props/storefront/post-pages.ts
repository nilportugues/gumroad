// PostsController#show on seller subdomains and custom domains (`seller:/p/:slug`) and
// GumroadBlog::PostsController#show (`/blog/p/:slug`). Rendered for a visitor who is not signed in
// (routes.json: signedOutOnly); a `purchase_id` param, a post with files and any format but HTML go
// to Rails.
import type { Installment, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { getConfig } from "../../infra/config.ts";
import { type Chain, type FilterOutcome, HandBackToRails, RoutingError } from "../../controllers/application-controller.ts";
import { assertFlatQuery, requestFormat } from "../../controllers/rails-params.ts";
import { isPresent, queryParam } from "../../controllers/rails-request.ts";
import { isFlagSet, isSuspended, nameOrUsername, Users } from "../../models/user.ts";
import type { PageSpec } from "../pages.ts";
import { AUDIENCE_TYPE, isPostVisible, postProps, setFaviconMetaTags, setPostPageMeta } from "./post.ts";
import { sellerOfHost } from "./seller-host.ts";

const SHOWN_ON_PROFILE_FLAG = 2 ** 7;
const NOT_ALLOWED = "You are not allowed to perform this action.";
const DEFAULT_BLOG_OWNER_USERNAME = "gumroad";

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// Anything but an HTML page (or an Inertia visit) is left to Rails, which negotiates the format.
export function requireHtmlPage(chain: Chain): void {
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) !== "html") throw new HandBackToRails();
  assertFlatQuery(chain.request.queryString);
}

// PostPresenter#set_purchase reads `purchase_id`; eligibility then depends on the purchase.
function refuseUnportedPostRequest(chain: Chain): void {
  if (queryParam(chain.request, "purchase_id") !== undefined) throw new HandBackToRails();
}

// `download_url` creates a UrlRedirect for a post with files.
async function handBackIfPostHasFiles(post: Installment): Promise<void> {
  const file = await db.productFile.findFirst({ where: { installment_id: post.id, deleted_at: null }, select: { id: true } });
  if (file) throw new HandBackToRails();
}

const slugOf = (chain: Chain, pattern: RegExp) => decode(pattern.exec(chain.request.path)?.[1] ?? "");

// PostsController#fetch_post(false)
async function fetchPost(slug: string): Promise<{ post: Installment; seller: User }> {
  const post = await db.installment.findFirst({ where: { slug }, orderBy: { id: "asc" } });
  if (!post) throw new RoutingError("Not Found");
  // `@post.link.seller` is a NoMethodError for a post without a seller: Rails answers 500.
  if (post.seller_id === null) {
    if (post.link_id !== null) throw new Error("undefined method 'seller' for an instance of Link");
    throw new RoutingError("Not Found");
  }
  const seller = await db.user.findFirst({ where: { id: post.seller_id } });
  if (!seller || isSuspended(Users.load(seller))) throw new RoutingError("Not Found");
  return { post, seller };
}

const SELLER_POST_PATH = /^\/p\/([^/.?]+)$/;

async function sellerPostFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtmlPage(chain);
  refuseUnportedPostRequest(chain);
  await sellerOfHost(new URL(`${chain.request.protocol}${chain.request.hostWithPort}`));
  const { post, seller } = await fetchPost(slugOf(chain, SELLER_POST_PATH));
  if (!(await isPostVisible(post))) throw new RoutingError("Not Found");
  await handBackIfPostHasFiles(post);
  return { state: { post_id: post.id, seller_id: String(seller.id) } };
}

const BLOG_POST_PATH = /^\/blog\/p\/([^/.?]+)$/;

// GumroadBlog::PostsPolicy#show? for a visitor who is not signed in.
const blogPostShown = (post: Installment) =>
  post.deleted_at === null && (post.flags & SHOWN_ON_PROFILE_FLAG) !== 0 && post.workflow_id === null && post.installment_type === AUDIENCE_TYPE && post.published_at !== null;

async function blogPostFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtmlPage(chain);
  refuseUnportedPostRequest(chain);
  const owner = await db.user.findFirst({ where: { username: getConfig("BLOG_OWNER_USERNAME", DEFAULT_BLOG_OWNER_USERNAME) }, orderBy: { id: "asc" } });
  if (!owner) throw new RoutingError("Not Found");
  const post = await db.installment.findFirst({ where: { seller_id: Number(owner.id), slug: slugOf(chain, BLOG_POST_PATH) }, orderBy: { id: "asc" } });
  if (!post) throw new RoutingError("Not Found");
  // Pundit::NotAuthorizedError: PunditAuthorization#default_user_not_authorized.
  if (!blogPostShown(post)) return { halt: { status: 302, location: `${chain.request.protocol}${chain.request.hostWithPort}/dashboard`, rescued: true, flash: { alert: NOT_ALLOWED } } };
  await handBackIfPostHasFiles(post);
  return { state: { post_id: post.id, seller_id: String(owner.id) } };
}

async function stateOf(state: Record<string, unknown>): Promise<{ post: Installment; seller: User }> {
  const post = (await db.installment.findFirst({ where: { id: state.post_id as number } }))!;
  const seller = (await db.user.findFirst({ where: { id: BigInt(state.seller_id as string) } }))!;
  return { post, seller };
}

// CustomDomainConfig#set_user_and_custom_domain_config
async function setHostMeta(meta: Parameters<PageSpec["props"]>[1]["meta"], host: User) {
  meta.set({ title: nameOrUsername(Users.load(host)) });
  const tag = host.facebook_meta_tag;
  if (isFlagSet(Users.load(host), "enable_verify_domain_third_party_services") && isPresent(tag)) {
    const content = /content=(["'])([^"']+)\1/u.exec(tag)?.[2];
    if (content) meta.set({ name: "facebook-domain-verification", content });
  }
}

export const POST_PAGES: Record<string, PageSpec> = {
  "seller:/p/:slug": {
    component: "Posts/Show",
    options: { filters: sellerPostFilters },
    props: async (_params, action) => {
      const { post, seller } = await stateOf(action.state);
      await setHostMeta(action.meta, await sellerOfHost(action.url));
      action.meta.set({ title: `${post.name} - ${nameOrUsername(Users.load(seller))}` });
      setPostPageMeta(action.meta, post);
      await setFaviconMetaTags(action.meta, seller);
      return postProps(post, seller);
    },
  },
  "/blog/p/:slug": {
    component: "GumroadBlog/Posts/Show",
    options: { filters: blogPostFilters },
    props: async (_params, action) => {
      const { post, seller } = await stateOf(action.state);
      return postProps(post, seller);
    },
  },
};
