// app/policies/audience/purchase_policy.rb (the Customers section)
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleSupportFor(c);
}

// `update? && record.link.is_physical?`
function markAsShipped(context: SellerContext, productIsPhysical: boolean): boolean {
  return update(context) && productIsPhysical;
}

// What revoke_access? reads off the record; `linkIsPhysical` is lazy because `record.link` is only touched once the earlier
// conditions hold (a purchase whose product is gone raises only then).
export type AccessRecord = { accessRevoked: boolean; refunded: boolean; hasSubscription: boolean; linkIsPhysical(): boolean };

// `update? && record.not_is_access_revoked && !record.refunded? && !record.link.is_physical && record.subscription.blank?`
function revokeAccess(context: SellerContext, record: AccessRecord): boolean {
  return update(context) && !record.accessRevoked && !record.refunded && !record.linkIsPhysical() && !record.hasSubscription;
}

// `update? && record.is_access_revoked`
function undoRevokeAccess(context: SellerContext, record: AccessRecord): boolean {
  return update(context) && record.accessRevoked;
}

export const audiencePurchasePolicy = { update, manageLicense: update, markAsShipped, revokeAccess, undoRevokeAccess };
