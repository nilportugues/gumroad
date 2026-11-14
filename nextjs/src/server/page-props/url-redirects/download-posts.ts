// UrlRedirectPresenter#posts: Purchase.product_installments over every purchase of the product the buyer's email maps to
// (a membership's charges and a purchased version's own posts included), and the view link of each post. A product that
// shows every past post and equal sort keys among more than two posts are Rails'.
import type { CustomDomain, Installment, Link, Purchase, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { cgiEscape } from "../../controllers/rails-params.ts";
import { InstallmentFlags, InstallmentPost } from "../../models/installment-post.ts";
import { LinkFlags } from "../../models/link.ts";
import { PurchaseRecord } from "../../models/purchase-pricing.ts";
import { purchasePassesFilters } from "../../models/with-filtering.ts";
import { jsonTime } from "../../presenters/mobile-serializers.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { displayedName } from "../audience/installments.ts";
import { protocol, userSubdomainWithProtocol, userUsername } from "../audience/support.ts";

const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];
const EMAIL_INFO_TYPE = "CreatorContactingCustomersEmailInfo";
const EPOCH = new Date("1970-01-01T00:00:00Z");

const notRefundedOrChargedBack = (purchase: Purchase) =>
  !purchase.stripe_refunded &&
  (purchase.chargeback_date === null || PurchaseFlags.isSet(purchase.flags, "chargeback_reversed"));

const CERTIFICATE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

// Purchase.for_displaying_installments (including test purchases) over the product's sales with this email, less what
// `can_access_content` drops: a deactivated membership of a product that blocks access after cancellation.
function displaysInstallments(purchase: Purchase, deactivatedBlocked: Set<bigint>): boolean {
  if (!(purchase.purchase_state && [...ALL_SUCCESS_STATES, "test_successful"].includes(purchase.purchase_state)))
    return false;
  if (purchase.subscription_id !== null && deactivatedBlocked.has(purchase.subscription_id)) return false;
  return notRefundedOrChargedBack(purchase) && !PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase");
}

// CustomDomain#active?: verified, with a certificate issued within its lifetime.
const isActive = (domain: CustomDomain) =>
  domain.state === "verified" &&
  domain.ssl_certificate_issued_at !== null &&
  domain.ssl_certificate_issued_at.getTime() > Date.now() - CERTIFICATE_LIFETIME_MS;

// group is the position of the scope in Purchase.product_installments' concatenation, which is the order ties keep.
type Listed = { post: Installment; sortKey: Date; group: number };

async function emailInfos(purchaseIds: bigint[], installmentIds: bigint[]) {
  if (purchaseIds.length === 0 || installmentIds.length === 0) return [];
  return db.emailInfo.findMany({
    where: { purchase_id: { in: purchaseIds }, installment_id: { in: installmentIds } },
    orderBy: { id: "asc" },
  });
}

const aliveAndPublished = (post: Installment) => post.deleted_at === null && post.published_at !== null;
const profileOnly = (post: Installment) =>
  !InstallmentFlags.isSet(post.flags, "send_emails") && InstallmentFlags.isSet(post.flags, "shown_on_profile");

export async function downloadPosts(purchase: Purchase | null, product: Link | null, seller: User): Promise<unknown[]> {
  if (purchase === null) return [];
  if (product === null) throw new HandBackToRails("posts of a purchase without a product");
  if (LinkFlags.isSet(product.flags, "should_show_all_posts"))
    throw new HandBackToRails("a product that shows every past post");
  if (purchase.email === null || purchase.email === "")
    throw new HandBackToRails("posts of a purchase without an email");

  const sales = await db.purchase.findMany({ where: { link_id: product.id, email: purchase.email } });
  const subscriptionIds = [...new Set(sales.flatMap((sale) => sale.subscription_id ?? []))];
  const deactivated =
    subscriptionIds.length === 0 || !LinkFlags.isSet(product.flags, "block_access_after_membership_cancellation")
      ? []
      : await db.subscription.findMany({
          where: { id: { in: subscriptionIds }, deactivated_at: { not: null } },
          select: { id: true },
        });
  const deactivatedBlocked = new Set(deactivated.map((row) => row.id));
  const displayed = sales.filter((sale) => displaysInstallments(sale, deactivatedBlocked));
  if (displayed.length === 0) return [];
  if (!displayed.some((sale) => sale.id === purchase.id))
    throw new HandBackToRails("posts of a purchase not displayed");
  const displayedIds = displayed.map((sale) => sale.id);

  const username = userUsername(seller);
  const domains = await db.customDomain.findMany({ where: { user_id: Number(seller.id), deleted_at: null } });
  // has_one :custom_domain takes an unspecified row when there are several.
  if (domains.length > 1) throw new HandBackToRails("posts of a seller with several custom domains");
  const activeDomain = domains.find(isActive);
  if (activeDomain && !activeDomain.domain) throw new HandBackToRails("posts of a custom domain without a name");
  const host = activeDomain ? `${protocol()}://${activeDomain.domain}` : userSubdomainWithProtocol(seller);
  if (username === null || host === null) throw new HandBackToRails("posts of a seller without a subdomain");

  // Purchases of the seller with the same address, whose emails also reach a seller post.
  const sameAddress = (await db.purchase.findMany({ where: { email: purchase.email, seller_id: purchase.seller_id } }))
    .filter((sale) => sale.purchase_state !== null && ALL_SUCCESS_STATES.includes(sale.purchase_state))
    .filter(notRefundedOrChargedBack)
    .map((sale) => sale.id);

  const listed: Listed[] = [];

  // installments_with_sent_emails: product or variant posts emailed to the purchase.
  const ownInfos = await db.emailInfo.findMany({
    where: { purchase_id: { in: displayedIds } },
    orderBy: { id: "asc" },
  });
  const emailed = await db.installment.findMany({
    where: {
      id: { in: ownInfos.flatMap((info) => (info.installment_id === null ? [] : [Number(info.installment_id)])) },
      installment_type: { in: ["product", "variant"] },
    },
  });
  for (const post of emailed.filter(aliveAndPublished)) {
    if (!InstallmentFlags.isSet(post.flags, "send_emails")) continue;
    // The scope joins email_infos, so a post emailed twice, or to two purchases, is listed twice.
    for (const info of ownInfos.filter((row) => Number(row.installment_id) === Number(post.id)))
      listed.push({ post, sortKey: info.sent_at ?? info.delivered_at ?? info.opened_at ?? EPOCH, group: 0 });
  }

  // profile_only_for_products
  const profilePosts = await db.installment.findMany({
    where: { link_id: Number(product.id), base_variant_id: null, installment_type: "product" },
  });
  for (const post of profilePosts.filter(aliveAndPublished).filter(profileOnly))
    listed.push({ post, sortKey: post.published_at!, group: 1 });

  // profile_only_for_variants: over the versions of every displayed purchase.
  const bought = await db.baseVariantsPurchase.findMany({
    where: { purchase_id: { in: displayedIds.map(Number) } },
    select: { base_variant_id: true },
  });
  const versionIds = bought.flatMap((row) => row.base_variant_id ?? []);
  if (versionIds.length > 0) {
    const versionPosts = await db.installment.findMany({
      where: { base_variant_id: { in: versionIds }, installment_type: "variant" },
    });
    for (const post of versionPosts.filter(aliveAndPublished).filter(profileOnly))
      listed.push({ post, sortKey: post.published_at!, group: 2 });
  }

  // seller_with_sent_emails_for_purchases and profile_only_for_sellers, narrowed by the buyer filters.
  const records = displayed.map((sale) => new PurchaseRecord(sale, null));
  // Purchase.product_installments keeps a post when any of the purchases passes its filters.
  const passes = async (post: Installment) => {
    for (const record of records) if (await purchasePassesFilters(new InstallmentPost(post), record)) return true;
    return false;
  };
  const sellerInfos = await db.emailInfo.findMany({
    where: { purchase_id: { in: [...displayedIds, ...sameAddress] } },
    orderBy: { id: "asc" },
  });
  const sellerEmailed = await db.installment.findMany({
    where: {
      id: { in: sellerInfos.flatMap((info) => (info.installment_id === null ? [] : [Number(info.installment_id)])) },
      installment_type: "seller",
    },
  });
  for (const post of sellerEmailed.filter(aliveAndPublished)) {
    if (!InstallmentFlags.isSet(post.flags, "send_emails")) continue;
    const infos = sellerInfos.filter((info) => Number(info.installment_id) === Number(post.id));
    if (infos.length > 1) throw new HandBackToRails("a seller post with several email infos");
    if (!(await passes(post))) continue;
    const info = infos[0]!;
    listed.push({ post, sortKey: info.sent_at ?? info.delivered_at ?? info.opened_at ?? EPOCH, group: 3 });
  }
  const sellerProfile = await db.installment.findMany({
    where: { seller_id: Number(purchase.seller_id), installment_type: "seller" },
  });
  for (const post of sellerProfile.filter(aliveAndPublished).filter(profileOnly)) {
    if (await passes(post)) listed.push({ post, sortKey: post.published_at!, group: 4 });
  }

  // sort_by(...).reverse: Ruby's sort is not stable, so a tie is only known for two posts, which no algorithm swaps.
  // Two rows of one scope tie in the order of that scope's SQL, which is not rebuilt here.
  const keys = listed.map((entry) => entry.sortKey.getTime());
  if (new Set(keys).size !== keys.length) {
    if (listed.length > 2) throw new HandBackToRails("more than two posts, two of which share a sort time");
    if (listed[0]!.group === listed[1]!.group)
      throw new HandBackToRails("two posts of one scope that share a sort time");
  }
  listed.sort((a, b) => a.sortKey.getTime() - b.sortKey.getTime());
  listed.reverse();

  // purchases.find { link_id == post.link_id } is the first row of the product's purchases, else the viewed one.
  const firstOfProduct = displayed.reduce((first, sale) => (sale.id < first.id ? sale : first));
  const result: unknown[] = [];
  for (const { post } of listed) {
    if (post.slug === null || post.slug === "") throw new HandBackToRails("a post without a slug");
    const owner = post.seller_id ?? product.user_id;
    if (owner === null || Number(owner) !== Number(seller.id)) throw new HandBackToRails("a post of another seller");
    const linked = post.link_id !== null && Number(post.link_id) === Number(product.id) ? firstOfProduct : purchase;
    result.push({
      id: encrypt(post.id),
      name: displayedName(post),
      action_at: await actionAt(post, displayedIds),
      view_url: `${host}/p/${post.slug}?purchase_id=${cgiEscape(encrypt(linked.id))}&username=${cgiEscape(username)}`,
    });
  }
  return result;
}

// Installment#action_at_for_purchases: the last email info of the purchases, else the publish time, else now.
async function actionAt(post: Installment, purchaseIds: bigint[]): Promise<string | null> {
  const [info] = (await emailInfos(purchaseIds, [BigInt(post.id)]))
    .filter((row) => row.type === EMAIL_INFO_TYPE)
    .sort((a, b) => Number(b.id - a.id));
  if (info === undefined) return jsonTime(post.published_at);
  const at = info.sent_at ?? info.delivered_at ?? info.opened_at;
  return jsonTime(at ?? new Date());
}
