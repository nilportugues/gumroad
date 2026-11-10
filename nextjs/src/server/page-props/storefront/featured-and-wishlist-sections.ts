// Port of app/presenters/profile_sections_presenter.rb (section_props) and app/presenters/wishlist_presenter.rb (card_props).
// The featured product and wishlists sections of a seller's profile, as ProfileSectionsPresenter#section_props renders
// them for a visitor who is not signed in. A product or card the port cannot prove throws NotPortedError, which
// `assertProductSectionsRender` turns into a hand-back before the page starts rendering.
import type { User, Wishlist } from "@prisma/client";

import { classifyHost } from "../../../lib/navigation/proxy/hosts.ts";
import { db } from "../../../lib/db.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { sellerCustomDomainUrl } from "../../presenters/product-page.ts";
import { customDomainByHost, findLink, findUserById } from "../../presenters/product-reads.ts";
import { productProps } from "../../presenters/product-props.ts";
import { authorBylineProps, subdomainWithProtocol, type PresenterRequest } from "../../presenters/product.ts";
import { thumbnailOrCoverUrl } from "../buyer/products.ts";
import { urlSlug } from "../buyer/wishlists.ts";
import { domainConfig } from "../domain.ts";
import { NotPortedError } from "../not-ported.ts";

export const FEATURED_PRODUCT_SECTION_TYPE = "SellerProfileFeaturedProductSection";
export const WISHLISTS_SECTION_TYPE = "SellerProfileWishlistsSection";
const GUID_COOKIE = "_gumroad_guid";
// Product::Layout::PROFILE
const PROFILE_LAYOUT = "profile";
const WISHLIST_CARD_THUMBNAILS = 4;

type SectionBase = { id: string; header: string | null; type: string };

// ApplicationController#seller_custom_domain_url, i.e. UserCustomDomainRequestService.valid?(request)
async function customDomainUrlOf(request: PresenterRequest): Promise<string | null> {
  const config = domainConfig(process.env);
  const custom = await customDomainByHost(request.host);
  const isUserCustomDomain = !classifyHost(request.host, config).gumroad && request.host !== config.validDiscoverRequestHost && custom?.product_id == null;
  return sellerCustomDomainUrl(isUserCustomDomain, request.hostWithPort);
}

// SellerProfileFeaturedProductSection: `seller.products.alive.find_by_external_id(featured_product_id)` and its
// ProductPresenter#product_props. An orphaned reference is "no featured product" (props: nil).
export async function featuredProductSectionProps(seller: User, base: SectionBase, data: Record<string, unknown>, request: PresenterRequest) {
  const featuredId = data.featured_product_id;
  const row = typeof featuredId === "number" ? await findLink(BigInt(featuredId)) : null;
  const alive = row !== null && row.user_id === seller.id && row.purchase_disabled_at === null && row.banned_at === null && row.deleted_at === null;
  if (!alive) return { ...base, props: null };
  const sellerRow = await findUserById(seller.id);
  const props = await productProps(row, sellerRow!, {
    user: null,
    context: null,
    remoteIp: request.remoteIp,
    browserGuid: request.cookies.get(GUID_COOKIE) ?? null,
    quantity: 1,
    discountCode: null,
    purchaseId: null,
    purchaseEmailDigest: null,
    recommendedBy: null,
    sellerCustomDomainUrl: await customDomainUrlOf(request),
    request,
  });
  return { ...base, props };
}

// WishlistPresenter#card_props for a visitor, `Wishlist.alive.where(id: shown_wishlists)` sorted by the seller's order.
export async function wishlistsSectionProps(base: SectionBase, data: Record<string, unknown>) {
  const shown = ((data.shown_wishlists ?? []) as number[]).map(Number);
  const wishlists = await db.wishlist.findMany({ where: { id: { in: shown.map(BigInt) }, deleted_at: null }, orderBy: { id: "asc" } });
  wishlists.sort((a, b) => shown.indexOf(Number(a.id)) - shown.indexOf(Number(b.id)));
  const cards = [];
  for (const wishlist of wishlists) cards.push(await wishlistCardProps(wishlist, { layout: PROFILE_LAYOUT }));
  return { ...base, shown_wishlists: shown.map((id) => externalId(BigInt(id))), wishlists: cards };
}

// WishlistPresenter#card_props: `following` and `can_follow` follow the pundit user's seller (none when signed out); the url
// carries `layout` and `recommended_by` the way url_for sorts them.
export async function wishlistCardProps(
  wishlist: Wishlist,
  { layout, recommendedBy = null, following = false, currentSellerId = null }: { layout: string; recommendedBy?: string | null; following?: boolean; currentSellerId?: bigint | null },
) {
  const owner = await findUserById(wishlist.user_id!);
  // Rails raises on a wishlist without an owner, or an owner without a subdomain to build its URL on.
  const host = owner ? subdomainWithProtocol(owner) : null;
  if (!owner || host === null) throw new NotPortedError("WishlistPresenter#card_props for a wishlist whose owner has no subdomain");
  const items = await db.wishlistProduct.findMany({ where: { wishlist_id: wishlist.id, deleted_at: null }, orderBy: { id: "desc" }, take: WISHLIST_CARD_THUMBNAILS });
  const thumbnails = [];
  for (const item of items.reverse()) {
    const product = await findLink(item.product_id);
    if (!product) throw new NotPortedError("WishlistPresenter#product_thumbnail for a missing product");
    thumbnails.push({ url: await thumbnailOrCoverUrl(product.id), native_type: product.native_type });
  }
  const query = [`layout=${layout}`, ...(recommendedBy ? [`recommended_by=${recommendedBy}`] : [])].join("&");
  return {
    id: externalId(wishlist.id),
    url: `${host}/wishlists/${urlSlug(wishlist)}?${query}`,
    name: wishlist.name,
    description: wishlist.description,
    seller: await authorBylineProps(owner),
    thumbnails: thumbnails.length < WISHLIST_CARD_THUMBNAILS ? thumbnails.slice(-1) : thumbnails,
    product_count: await db.wishlistProduct.count({ where: { wishlist_id: wishlist.id, deleted_at: null } }),
    follower_count: wishlist.follower_count,
    following,
    can_follow: currentSellerId !== wishlist.user_id,
  };
}
