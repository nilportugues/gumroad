// app/policies/settings/social_connections_policy.rb
import { requireUser, roleOwnerFor, type SellerContext } from "../seller-context.ts";

export const settingsSocialConnectionsPolicy = { show: (context: SellerContext) => roleOwnerFor(requireUser(context)) };
