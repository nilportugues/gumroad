// app/policies/installment_policy.rb (the Posts section)
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

function create(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const installmentPolicy = {
  index,
  preview: index,
  create,
  new: create,
  edit: create,
  update: create,
  destroy: create,
  publish: create,
  schedule: create,
  delete: create,
  redirectFromPurchaseId: create,
  updatedRecipientCount: create,
  updatedAudienceCount: create,
  resendToNonOpeners: create,
  sendToRemaining: create,
  sendForPurchase(context: SellerContext): boolean {
    return create(context) || roleSupportFor(requireUser(context));
  },
};
