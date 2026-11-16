// SellerPlanOffer and SellerPlan::StripeEventHandler (app/models/seller_plan_offer.rb, app/services/seller_plan/stripe_event_handler.rb):
// the platform-account `checkout.session.completed` and `customer.subscription.*` events, whose only effect is the offer row.
// Golden: worker/jobs/__fixtures__/stripe-event-routing.golden.json (scripts/golden/stripe-event-routing.rb).
import { Prisma, type SellerPlanOffer } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank, validatesInclusionOf, validatesNumericalityOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { type EventObject, isObject, railsIntegerCast } from "./stripe-event-values.ts";
import { NotPortedError } from "./user.ts";

const SOURCE = "seller_plan/stripe_event_handler.rb";
const SELLER_PLAN_ARMS = ["five", "ten"];
const SELLER_PLAN_STATUSES = ["offered", "checkout_started", "active", "past_due", "canceled"];
const TERMINAL_STATUSES = ["canceled", "incomplete_expired"];

export const SellerPlanOffers = defineModel<SellerPlanOffer>({
  rubyClass: "SellerPlanOffer",
  prismaModel: "SellerPlanOffer",
  delegate: (tx) => tx.sellerPlanOffer as never,
  // belongs_to :user is required; belongs_to :product is optional.
  validations: [
    belongsToRequired<SellerPlanOffer>({
      name: "user",
      foreignKey: "user_id",
      targetTable: "users",
      targetModel: "User",
    }),
    validatesInclusionOf<SellerPlanOffer>(["arm"], { in: SELLER_PLAN_ARMS }),
    validatesNumericalityOf<SellerPlanOffer>(["price_cents"], { only_integer: true, greater_than: 0 }),
    validatesInclusionOf<SellerPlanOffer>(["status"], { in: SELLER_PLAN_STATUSES }),
  ],
});

const stringOrNil = (value: unknown, what: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new NotPortedError(`${what} that is not a String`, SOURCE);
  return value;
};

// offer_from: `metadata&.[]("seller_plan_offer_id")`, `return nil if id.blank?`, `SellerPlanOffer.find_by(id:)`.
async function offerFrom(metadata: unknown) {
  if (metadata === null || metadata === undefined) return null;
  if (!isObject(metadata)) throw new NotPortedError("event metadata that is not a Hash", SOURCE);
  const id = metadata.seller_plan_offer_id;
  if (id === null || id === undefined) return null;
  let key: bigint | null;
  if (typeof id === "string") {
    if (isBlank(id)) return null;
    key = railsIntegerCast(id);
  } else if (typeof id === "number" && Number.isSafeInteger(id)) {
    key = BigInt(id);
  } else {
    throw new NotPortedError("a seller_plan_offer_id that is not a String or an Integer", SOURCE);
  }
  const star = Prisma.raw("`seller_plan_offers`.*");
  const idColumn = column("seller_plan_offers", "id");
  // A string with no leading digit casts to nil, which the statement binds as `= NULL`.
  const [row] = await selectRows(
    key === null
      ? Prisma.sql`SELECT ${star} FROM ${table("seller_plan_offers")} WHERE ${idColumn} = NULL LIMIT 1`
      : Prisma.sql`SELECT ${star} FROM ${table("seller_plan_offers")} WHERE ${idColumn} = ${key} LIMIT 1`,
  );
  return row ? SellerPlanOffers.load(castRow<SellerPlanOffer>("SellerPlanOffer", row)) : null;
}

async function activateFromCheckout(session: EventObject, now: () => Date): Promise<void> {
  const offer = await offerFrom(session.metadata);
  if (offer === null) return;
  const subscription = stringOrNil(session.subscription, "a checkout session subscription");
  const customer = stringOrNil(session.customer, "a checkout session customer");
  const held = offer.get("stripe_subscription_id");
  if (offer.get("status") === "active" && !isBlank(held) && held !== subscription) {
    notifyError(`Seller plan offer ${offer.get("id")} completed a second checkout (${subscription ?? ""})`);
    return;
  }
  offer.assign({
    status: "active",
    stripe_customer_id: customer,
    stripe_subscription_id: subscription,
    activated_at: now(),
    canceled_at: null,
  });
  await SellerPlanOffers.saveBang(offer, { now });
}

async function syncSubscription(subscription: EventObject, now: () => Date): Promise<void> {
  const offer = await offerFrom(subscription.metadata);
  if (offer === null) return;
  const id = stringOrNil(subscription.id, "a subscription id");
  const status = stringOrNil(subscription.status, "a subscription status");
  const held = offer.get("stripe_subscription_id");
  if (!isBlank(held) && held !== id) return;

  const adopts = isBlank(held) && !isBlank(id);
  // A terminal event for a subscription this offer never held must not claim it: adopting that id would make every
  // later event from the live subscription look stale.
  if (adopts && TERMINAL_STATUSES.includes(status ?? "")) return;
  if (adopts) {
    offer.assign({ stripe_subscription_id: id });
    await SellerPlanOffers.saveBang(offer, { now });
  }

  if (status === "active" || status === "trialing") {
    offer.assign({ status: "active", activated_at: offer.get("activated_at") ?? now(), canceled_at: null });
  } else if (status === "past_due" || status === "unpaid") {
    offer.assign({ status: "past_due" });
  } else if (status === "canceled" || status === "incomplete_expired") {
    offer.assign({ status: "canceled", canceled_at: now() });
  } else {
    return;
  }
  await SellerPlanOffers.saveBang(offer, { now });
}

export function handleSellerPlanStripeEvent(type: string, object: EventObject, now: () => Date): Promise<void> {
  if (type === "checkout.session.completed") return activateFromCheckout(object, now);
  return syncSubscription(object, now);
}
