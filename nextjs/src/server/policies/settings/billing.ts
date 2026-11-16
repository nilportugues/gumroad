// app/policies/settings/billing_policy.rb
import { requireUser, roleOwnerFor, type SellerContext } from "../seller-context.ts";

// `user == seller`
const show = (context: SellerContext) => roleOwnerFor(requireUser(context));

export const settingsBillingPolicy = { show, update: show };
