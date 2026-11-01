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

export const collaboratorPolicy = { index, create: index, new: index, edit, update: edit };
