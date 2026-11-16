// app/policies/checkout/form_policy.rb
import {
  requireUser,
  roleAccountantFor,
  roleAdminFor,
  roleMarketingFor,
  roleSupportFor,
  type SellerContext,
} from "./seller-context.ts";

function show(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const checkoutFormPolicy = { show, update };
