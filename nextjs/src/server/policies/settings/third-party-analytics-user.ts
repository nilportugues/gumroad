// app/policies/settings/third_party_analytics/user_policy.rb
import { requireUser, roleAdminFor, type SellerContext } from "../seller-context.ts";

const show = (context: SellerContext) => roleAdminFor(requireUser(context));

export const settingsThirdPartyAnalyticsUserPolicy = { show, update: show };
