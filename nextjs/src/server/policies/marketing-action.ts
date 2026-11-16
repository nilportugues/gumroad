// app/policies/marketing/action_policy.rb
import { requireUser, roleAdminFor, roleMarketingFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

function show(context: SellerContext, record: { user_id: bigint }): boolean {
  return index(context) && record.user_id === context.seller?.id;
}

export const marketingActionPolicy = { index, show, approve: show, execute: show, cancel: show };
