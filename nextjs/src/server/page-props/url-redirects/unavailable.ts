// UrlRedirectsController#expired, #rental_expired_page, #membership_inactive_page and #confirm_page: the
// pages that tell a buyer their content is gone or ask for the purchase email. None of them runs
// check_permissions or the download page's after_actions, so they write nothing; they read
// UrlRedirectPresenter#download_page_without_content_props.
import type { Link, Purchase, Subscription, UrlRedirect, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { isPresent, queryParam } from "../../controllers/rails-request.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { UserFlags } from "../../models/user.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { emailDigest, raterAccountName } from "../buyer/reviews.ts";
import { productLongUrl } from "../buyer/users.ts";
import { domainConfig } from "../domain.ts";

export const CONTENT_UNAVAILABILITY_REASON_CODES = {
  inactive_membership: "inactive_membership",
  rental_expired: "rental_expired",
  access_expired: "access_expired",
  email_confirmation_required: "email_confirmation_required",
} as const;

type ReasonCode = (typeof CONTENT_UNAVAILABILITY_REASON_CODES)[keyof typeof CONTENT_UNAVAILABILITY_REASON_CODES];

export type UnavailablePage = "expired" | "rental_expired" | "membership_inactive" | "confirm";

const PAGE_PATHS: Record<Exclude<UnavailablePage, "confirm">, RegExp> = {
  expired: /^\/r\/([^/.]+)\/expired$/u,
  rental_expired: /^\/r\/([^/.]+)\/rental_expired$/u,
  membership_inactive: /^\/r\/([^/.]+)\/membership_inactive$/u,
};

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const present = (value: string | null | undefined): value is string => isPresent(value);

export type Loaded = {
  redirect: UrlRedirect;
  purchase: Purchase | null;
  product: Link | null;
  seller: User | null;
  purchaser: User | null;
  subscription: Subscription | null;
  receiptPurchase: Purchase | null;
  variantId: string | null;
  successfulCharges: number;
};

// UrlRedirect.find_by(token:) then the checks fetch_url_redirect makes for a redirect that hangs off
// an installment. Those, an imported customer and the records the layout props read through the
// presenters (reviews, post-purchase custom fields, calls, bundles) are left to Rails.
export async function load(token: string): Promise<Loaded> {
  const redirect = await db.urlRedirect.findUnique({ where: { token } });
  if (!redirect) throw new RoutingError("Not Found");
  if (redirect.installment_id !== null || redirect.imported_customer_id !== null) throw new HandBackToRails();

  const purchase =
    redirect.purchase_id === null ? null : await db.purchase.findUnique({ where: { id: redirect.purchase_id } });
  const productId = purchase ? purchase.link_id : redirect.link_id;
  const product = productId === null ? null : await db.link.findUnique({ where: { id: productId } });
  if (!purchase)
    return {
      redirect,
      purchase,
      product,
      seller: null,
      purchaser: null,
      subscription: null,
      receiptPurchase: null,
      variantId: null,
      successfulCharges: 0,
    };

  if (
    PurchaseFlags.isSet(purchase.flags, "is_bundle_product_purchase") ||
    PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")
  )
    throw new HandBackToRails();

  const seller = purchase.seller_id === null ? null : await db.user.findUnique({ where: { id: purchase.seller_id } });
  const purchaser =
    purchase.purchaser_id === null ? null : await db.user.findUnique({ where: { id: purchase.purchaser_id } });
  const subscription =
    purchase.subscription_id === null
      ? null
      : await db.subscription.findUnique({ where: { id: purchase.subscription_id } });

  const reviewPurchaseIds = [purchase.id];
  if (subscription) {
    const originals = await db.purchase.findMany({
      where: { subscription_id: subscription.id },
      select: { id: true, flags: true },
    });
    for (const original of originals)
      if (PurchaseFlags.isSet(original.flags, "is_original_subscription_purchase")) reviewPurchaseIds.push(original.id);
  }
  if ((await db.productReview.count({ where: { purchase_id: { in: reviewPurchaseIds } } })) > 0)
    throw new HandBackToRails();
  if ((await db.call.count({ where: { purchase_id: purchase.id } })) > 0) throw new HandBackToRails();
  const postPurchaseFields = await db.purchaseCustomField.findMany({
    where: { purchase_id: purchase.id, custom_field_id: { not: null } },
    select: { flags: true },
  });
  if (postPurchaseFields.some((field) => (field.flags & 1n) !== 0n)) throw new HandBackToRails();

  const successfulCharges = subscription
    ? await db.purchase.count({
        where: {
          subscription_id: subscription.id,
          purchase_state: SubscriptionFlags.isSet(subscription.flags, "is_test_subscription")
            ? "test_successful"
            : "successful",
        },
      })
    : 0;

  return {
    redirect,
    purchase,
    product,
    seller,
    purchaser,
    subscription,
    receiptPurchase: await receiptPurchaseOf(purchase, subscription),
    variantId: await purchasedVariantId(purchase),
    successfulCharges,
  };
}

// Purchase#receipt_purchase (bundle products were handed back above): a membership's latest charge that
// was not refunded or charged back, unless it belongs to someone else or is a gift.
async function receiptPurchaseOf(purchase: Purchase, subscription: Subscription | null): Promise<Purchase> {
  if (!subscription) return purchase;
  const state = SubscriptionFlags.isSet(subscription.flags, "is_test_subscription") ? "test_successful" : "successful";
  const candidates = await db.purchase.findMany({
    where: {
      subscription_id: subscription.id,
      purchase_state: state,
      OR: [{ stripe_refunded: null }, { stripe_refunded: false }],
      AND: [{ OR: [{ chargeback_date: null }, { chargeback_date: { not: null } }] }],
    },
    orderBy: { succeeded_at: "desc" },
  });
  const candidate = candidates.find(
    (row) => row.chargeback_date === null || PurchaseFlags.isSet(row.flags, "chargeback_reversed"),
  );
  if (!candidate || candidate.id === purchase.id) return purchase;
  if (PurchaseFlags.isSet(candidate.flags, "is_gift_sender_purchase")) return purchase;
  return candidate.email === purchase.email ? candidate : purchase;
}

// UrlRedirect#with_product_files for a redirect without an installment: the first purchased Variant
// when there is one, else the product (not a BaseVariant, so no variant_id).
async function purchasedVariantId(purchase: Purchase): Promise<string | null> {
  const links = await db.baseVariantsPurchase.findMany({ where: { purchase_id: Number(purchase.id) } });
  const variantIds = links.flatMap((link) => (link.base_variant_id === null ? [] : [link.base_variant_id]));
  if (variantIds.length === 0) return null;
  const variants = await db.baseVariant.findMany({ where: { id: { in: variantIds }, type: "Variant" } });
  if (variants.length > 1) throw new HandBackToRails();
  return variants[0] ? encrypt(variants[0].id) : null;
}

// ApplicationController filters, then fetch_url_redirect (UrlRedirectsController is not signed-in only).
export function unavailableFilters(page: UnavailablePage) {
  return async (chain: Chain): Promise<FilterOutcome> => {
    requireHtml(chain);
    assertFlatQuery(chain.request.queryString);
    const token = page === "confirm" ? queryParam(chain.request, "id") : PAGE_PATHS[page].exec(chain.request.path)?.[1];
    if (token === undefined || token === null) throw new RoutingError("Not Found");
    const loaded = await load(page === "confirm" ? token : safeDecode(token));
    // The state travels in a request header, so the props reload the records from the token.
    if (page === "confirm") {
      chain.headers.set("x-robots-tag", "noindex");
      if (!present(queryParam(chain.request, "destination")) && (await hasRichContent(loaded)))
        throw new HandBackToRails();
    }
    return { state: {} };
  };
}

// `rich_content_json.present?` for the default destination: any page the product or a variant has, or a
// completed commission, is left to Rails.
export async function hasRichContent({ product, purchase }: Loaded): Promise<boolean> {
  if (!product) return false;
  const categories = await db.variantCategory.findMany({
    where: { link_id: Number(product.id) },
    select: { id: true },
  });
  const variants = await db.baseVariant.findMany({
    where: { variant_category_id: { in: categories.map((category) => category.id) } },
    select: { id: true },
  });
  const rows = await db.richContent.count({
    where: {
      deleted_at: null,
      OR: [
        { entity_type: "Link", entity_id: product.id },
        {
          entity_type: { in: ["Variant", "BaseVariant"] },
          entity_id: { in: variants.map((variant) => BigInt(variant.id)) },
        },
      ],
    },
  });
  if (rows > 0) return true;
  if (!purchase) return false;
  return (
    (await db.commission.count({
      where: { OR: [{ deposit_purchase_id: purchase.id }, { completion_purchase_id: purchase.id }] },
    })) > 0
  );
}

// Purchase#claim_by_seller?
export function claimBySeller(loaded: Loaded, user: User | null): boolean {
  const { purchase, product } = loaded;
  if (!purchase || !user || !product || product.user_id !== user.id) return false;
  if (product.user_id === purchase.purchaser_id) return false;
  return purchase.purchaser_id !== null || (purchase.email ?? "").toLowerCase() !== (user.email ?? "").toLowerCase();
}

const rootDomainWithProtocol = () => `${domainConfig(process.env).protocol}://${domainConfig(process.env).rootDomain}`;

// Purchase#has_invoice? on the receipt purchase: free_purchase? is `price_cents == 0 && shipping_cents == 0`.
function hasInvoice(receipt: Purchase): boolean {
  if (receipt.subscription_id !== null) return !PurchaseFlags.isSet(receipt.flags, "is_free_trial_purchase");
  return !(receipt.price_cents === 0 && receipt.shipping_cents === 0);
}

// Purchase::Reviews#allows_review? (`allows_reviews(permit_recurring_charges: true)`).
function allowsReview(purchase: Purchase): boolean {
  const flag = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  let allowed = ["successful", "gift_receiver_purchase_successful", "not_charged"].includes(
    purchase.purchase_state ?? "",
  );
  allowed &&= !flag("should_exclude_product_review");
  allowed &&= !(purchase.purchase_state === "not_charged" && !flag("is_free_trial_purchase"));
  allowed &&= !flag("is_gift_sender_purchase");
  allowed &&= purchase.stripe_refunded !== true;
  allowed &&= purchase.stripe_partially_refunded !== true || !flag("is_bundle_product_purchase");
  allowed &&= purchase.chargeback_date == null;
  allowed &&= !flag("is_access_revoked") || (purchase.price_cents ?? 0) > 0;
  allowed &&= !flag("is_commission_completion_purchase");
  return allowed;
}

function membershipProps({ subscription, successfulCharges }: Loaded, now: Date) {
  if (!subscription) return null;
  const {
    cancelled_at: cancelledAt,
    failed_at: failedAt,
    ended_at: endedAt,
    charge_occurrence_count: occurrences,
    free_trial_ends_at: trialEndsAt,
  } = subscription;
  const aliveWithoutPending = failedAt === null && endedAt === null && cancelledAt === null;
  const installmentPlan = SubscriptionFlags.isSet(subscription.flags, "is_installment_plan");
  // cancelled?(treat_pending_cancellation_as_live: false) && !cancelled_by_buyer?
  const cancelled = !aliveWithoutPending && cancelledAt !== null;
  const cancelledBySellerFlag = cancelled && !SubscriptionFlags.isSet(subscription.flags, "cancelled_by_buyer");
  return {
    has_active_subscription: aliveWithoutPending,
    subscription_id: encrypt(subscription.id),
    is_subscription_ended: endedAt !== null,
    is_installment_plan_completed: installmentPlan && occurrences !== null && successfulCharges === occurrences,
    is_subscription_cancelled_or_failed: cancelledAt !== null || failedAt !== null,
    is_alive_or_restartable: endedAt === null && !cancelledBySellerFlag,
    in_free_trial: trialEndsAt !== null && trialEndsAt.getTime() > now.getTime(),
    is_installment_plan: installmentPlan,
  };
}

// purchase.seller.disable_reviews_after_year?
function disablesReviewsAfterYear(seller: User | null): boolean {
  if (!seller) throw new TypeError("undefined method 'disable_reviews_after_year?' for nil");
  return UserFlags.isSet(seller.flags, "disable_reviews_after_year");
}

// purchase.seller.name_or_username: a seller with neither falls back to an external id the rows do not carry here.
function sellerName(seller: User | null): string {
  if (!seller) throw new TypeError("undefined method 'name_or_username' for nil");
  const name = [seller.name, seller.username].find((value) => isPresent(value));
  if (name === undefined || name === null) throw new HandBackToRails("a seller with neither name nor username");
  return name;
}

// UrlRedirectPresenter#download_page_layout_props
export function layoutProps(loaded: Loaded, emailConfirmationRequired: boolean, now: Date) {
  const { redirect, purchase, product, seller, purchaser, receiptPurchase, variantId } = loaded;
  return {
    terms_page_url: `${rootDomainWithProtocol()}/terms`,
    token: redirect.token,
    redirect_id: encrypt(redirect.id),
    purchase: purchase
      ? {
          id: encrypt(purchase.id),
          receipt_purchase_id: receiptPurchase ? encrypt(receiptPurchase.id) : null,
          email: emailConfirmationRequired ? null : purchase.email,
          free: purchase.price_cents === 0 && purchase.shipping_cents === 0,
          seller_name: sellerName(seller),
          email_digest: emailDigest(purchase),
          created_at: purchase.created_at?.toISOString() ?? null,
          is_archived: PurchaseFlags.isSet(purchase.flags, "is_archived"),
          has_invoice: receiptPurchase ? hasInvoice(receiptPurchase) : false,
          product_permalink: product ? product.unique_permalink : null,
          product_id: product ? encrypt(product.id) : null,
          product_name: product ? product.name : null,
          variant_id: variantId,
          product_long_url: product && seller ? productLongUrl(product, seller) : null,
          allows_review: allowsReview(purchase),
          product_available: !(product && product.deleted_at !== null),
          disable_reviews_after_year: disablesReviewsAfterYear(seller),
          review: null,
          review_account_name: raterAccountName(purchase, purchaser),
          membership: membershipProps(loaded, now),
          purchase_custom_fields: [],
          call: null,
        }
      : null,
  };
}

// UrlRedirectsController#common_props merged with the page's own extras, over the layout props.
export async function unavailablePageProps(
  page: UnavailablePage,
  token: string,
  {
    loggedInUser,
    display,
    destination,
    email,
    now,
  }: { loggedInUser: User | null; display: string | null; destination: string | null; email: string | null; now: Date },
) {
  const loaded = await load(token);
  const { purchase, purchaser } = loaded;

  let addToLibraryOption = "none";
  if (purchase && !purchaser && !claimBySeller(loaded, loggedInUser))
    addToLibraryOption = loggedInUser ? "add_to_library_button" : "signup_form";

  const reasonCode: ReasonCode | null =
    page === "confirm"
      ? CONTENT_UNAVAILABILITY_REASON_CODES.email_confirmation_required
      : page === "expired"
        ? CONTENT_UNAVAILABILITY_REASON_CODES.access_expired
        : page === "rental_expired"
          ? CONTENT_UNAVAILABILITY_REASON_CODES.rental_expired
          : CONTENT_UNAVAILABILITY_REASON_CODES.inactive_membership;

  const props: Record<string, unknown> = {
    ...layoutProps(loaded, reasonCode === CONTENT_UNAVAILABILITY_REASON_CODES.email_confirmation_required, now),
    is_mobile_app_web_view: display === "mobile_app",
    content_unavailability_reason_code: reasonCode,
    add_to_library_option: addToLibraryOption,
  };
  if (page === "confirm") {
    props.confirmation_info = {
      id: loaded.redirect.token,
      destination: present(destination) ? destination : null,
      display,
      email,
      is_gift: purchase ? PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase") : false,
    };
  }
  return props;
}

const SUFFIXES: Record<Exclude<UnavailablePage, "confirm">, string> = {
  expired: "Access expired",
  rental_expired: "Your rental has expired",
  membership_inactive: "Your membership is inactive",
};

// #content_unavailable_page_title (an installment's name is left to Rails with the installment itself)
// and confirm_page's "<name> - Confirm email".
export async function unavailableTitle(page: UnavailablePage, token: string): Promise<string> {
  const { product } = await load(token);
  if (page === "confirm") {
    if (!product) throw new TypeError("undefined method 'name' for nil");
    return `${product.name} - Confirm email`;
  }
  const name = product && present(product.name) ? product.name : null;
  return name ? `${name} - ${SUFFIXES[page]}` : SUFFIXES[page];
}
