// app/policies/collaborator_policy.rb
import { requireUser, roleAdminFor, type SellerContext } from "./seller-context.ts";

// `authorize Collaborator, :index?` (the class: no record to compare against).
function index(context: SellerContext): boolean {
  return roleAdminFor(requireUser(context));
}

// `authorize @collaborator, :edit?`: the collaboration must belong to the acting seller.
function edit(context: SellerContext, record: { seller_id: number | bigint }): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) && c.seller !== null && BigInt(record.seller_id) === c.seller.id;
}

// `authorize @collaborator, :destroy?`: either side of the collaboration may end it.
function destroy(
  context: SellerContext,
  record: { seller_id: number | bigint; affiliate_user_id: number | bigint | null },
): boolean {
  const c = requireUser(context);
  if (!roleAdminFor(c) || c.seller === null) return false;
  return (
    BigInt(record.seller_id) === c.seller.id ||
    (record.affiliate_user_id !== null && BigInt(record.affiliate_user_id) === c.seller.id)
  );
}

// app/policies/collaborator_invitation_policy.rb: only the invited seller answers the invitation.
function accept(context: SellerContext, record: { affiliate_user_id: number | bigint | null }): boolean {
  const c = requireUser(context);
  return (
    roleAdminFor(c) &&
    c.seller !== null &&
    record.affiliate_user_id !== null &&
    BigInt(record.affiliate_user_id) === c.seller.id
  );
}

export const collaboratorPolicy = { index, create: index, new: index, edit, update: edit, destroy };
export const collaboratorInvitationPolicy = { accept, decline: accept };
