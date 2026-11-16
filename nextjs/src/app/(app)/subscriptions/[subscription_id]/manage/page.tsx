// SubscriptionsController#manage. Only the access check is ported (server/controllers/subscription-pages.ts): a
// visitor who may manage the subscription is handed to Rails before this renders, so reaching it is a bug.
import { NotPortedError } from "@/server/page-props/not-ported";

export default function Page(): never {
  throw new NotPortedError("Subscriptions/Manage (CheckoutPresenter#subscription_manager_props)");
}
