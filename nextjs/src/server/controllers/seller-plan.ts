// SellerPlanController#checkout (GET /seller_plan/checkout) and SellerPlan::Checkout: turns the seller's plan offer into a hosted Stripe
// Checkout session on Gumroad's own account and sends the seller there.
//
// Every failure after the sign-in and account email checks is a redirect with a flash, because the action's method-level
// `rescue StandardError` also catches the Pundit refusal of `authorize`.
import * as Routes from "@/lib/navigation/routes";

import { db } from "../../lib/db.ts";
import { getConfig } from "../infra/config.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { sellerPlanOfferPolicy } from "../policies/seller-plan-offer.ts";
import { APIConnectionError, InvalidRequestError, RateLimitError } from "../stripe/errors.ts";
import { CheckoutSession } from "../stripe/resources.ts";

import { HandBackToRails, type Redirected } from "./application-controller.ts";
import { registerMutations } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";

// Checkout calls Stripe while it holds the offer row, as `with_lock` does.
const LOCK_TRANSACTION_TIMEOUT_MS = 120_000;
const PRICE_CONFIG_KEYS: Record<string, string> = { five: "SELLER_PLAN_PRICE_5", ten: "SELLER_PLAN_PRICE_10" };
const RESTARTABLE_STATUSES = ["offered", "canceled"];

const GENERIC_FAILURE = "We couldn't start your plan checkout. Email support@gumroad.com and we'll sort it out.";
const PRICE_MISSING =
  "The seller plan isn't available right now, so publishing is still free today. Email support@gumroad.com and we'll turn it on for you.";
const UNREACHABLE = "We couldn't reach our payment provider. Wait a minute, then publish again to retry.";

class AlreadyActive extends Error {}
class PriceMissing extends Error {}

const redirect = (location: string, flash?: Record<string, string>): Redirected => ({
  status: 302,
  location,
  ...(flash && { flash }),
});

type Offer = NonNullable<Awaited<ReturnType<typeof db.sellerPlanOffer.findUnique>>>;

// SellerPlan::Checkout#url
async function checkoutUrl(offer: Offer, editUrl: string): Promise<string> {
  const priceId = getConfig(PRICE_CONFIG_KEYS[offer.arm] ?? "");
  if (!priceId) throw new PriceMissing(`No Stripe price configured for the ${offer.arm} arm`);

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM seller_plan_offers WHERE id = ${offer.id} LIMIT 1 FOR UPDATE`;
      const locked = await tx.sellerPlanOffer.findUniqueOrThrow({ where: { id: offer.id } });
      if (locked.status === "active") throw new AlreadyActive("Seller plan is already active");

      if (locked.stripe_checkout_session_id) {
        try {
          const existing = await CheckoutSession.retrieve(locked.stripe_checkout_session_id);
          if (existing.status === "open") return existing.url as string;
        } catch (error) {
          if (!(error instanceof InvalidRequestError)) throw error;
        }
      }

      const user = await tx.user.findUniqueOrThrow({ where: { id: locked.user_id }, select: { email: true } });
      const metadata = { seller_plan_offer_id: String(locked.id), user_id: String(locked.user_id) };
      const session = await CheckoutSession.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: user.email,
        client_reference_id: String(locked.id),
        metadata,
        subscription_data: { metadata },
        success_url: editUrl,
        cancel_url: editUrl,
        allow_promotion_codes: false,
      });
      await tx.sellerPlanOffer.update({
        where: { id: locked.id },
        data: {
          stripe_checkout_session_id: session.id,
          ...(RESTARTABLE_STATUSES.includes(locked.status) && { status: "checkout_started" }),
          updated_at: new Date(),
        },
      });
      return session.url as string;
    },
    { timeout: LOCK_TRANSACTION_TIMEOUT_MS },
  );
}

registerMutations({
  method: "GET",
  pattern: "/seller_plan/checkout",
  // A GET never runs with a null session.
  skipForgeryProtection: true,
  run: async (input) => {
    // RequireAccountEmail and Pundit answer JSON and other formats differently.
    if (requestFormat(input.request) !== "html")
      throw new HandBackToRails("a seller plan checkout requested in another format");
    const guard = await sellerGuard(
      {
        context: input.context,
        config: domainConfig(process.env),
        url: input.url,
        params: input.routeParams,
        urlOptions: input.urlOptions,
      },
      () => undefined,
    );
    if (guard) return guard;

    const rootUrl = Routes.root_url(input.urlOptions);
    let editUrl: string | null = null;
    try {
      authorize(sellerPlanOfferPolicy.checkout, await loadSellerContext(input.context));
      const offer = await db.sellerPlanOffer.findUnique({ where: { user_id: input.context.currentSeller!.id } });
      if (offer === null) return redirect(rootUrl, { alert: "That plan offer is no longer available." });

      const product = offer.product_id === null ? null : await db.link.findUnique({ where: { id: offer.product_id } });
      if (product === null) throw new TypeError("undefined method 'unique_permalink' for nil");
      editUrl = Routes.edit_link_url(product.unique_permalink, input.urlOptions);
      if (offer.status === "active") return redirect(editUrl);

      return redirect(await checkoutUrl(offer, editUrl));
    } catch (error) {
      if (error instanceof HandBackToRails) throw error;
      if (error instanceof AlreadyActive && editUrl !== null)
        return redirect(editUrl, { notice: "Your seller plan is already active. Publish again to continue." });
      notifyError(error);
      if (error instanceof PriceMissing) return redirect(rootUrl, { alert: PRICE_MISSING });
      if ((error instanceof APIConnectionError || error instanceof RateLimitError) && editUrl !== null)
        return redirect(editUrl, { alert: UNREACHABLE });
      return redirect(rootUrl, { alert: GENERIC_FAILURE });
    }
  },
});
