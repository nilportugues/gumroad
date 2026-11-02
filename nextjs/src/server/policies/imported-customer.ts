// app/policies/imported_customer_policy.rb
import { audiencePurchasePolicy } from "./audience-purchase.ts";
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

// `Pundit.policy!(@context, [:audience, Purchase]).update?`
const update = (context: SellerContext) => audiencePurchasePolicy.update(context);

export const importedCustomerPolicy = { index, update, destroy: update };
