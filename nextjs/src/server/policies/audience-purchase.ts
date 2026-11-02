// app/policies/audience/purchase_policy.rb (the Customers section)
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleSupportFor(c);
}

export const audiencePurchasePolicy = { update, manageLicense: update };
