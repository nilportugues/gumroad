// app/policies/checkout/upsell_policy.rb
import {
  requireUser,
  roleAccountantFor,
  roleAdminFor,
  roleMarketingFor,
  roleSupportFor,
  type SellerContext,
} from "./seller-context.ts";

type UpsellRecord = { seller_id: bigint | number | null };

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c) || roleAccountantFor(c);
}

function create(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

// `create? && record.seller == seller`
function update(context: SellerContext, record: UpsellRecord): boolean {
  return create(context) && record.seller_id != null && BigInt(record.seller_id) === context.seller?.id;
}

export const checkoutUpsellPolicy = {
  index,
  paged: index,
  cart_item: index,
  statistics: index,
  create,
  update,
  destroy: update,
  pause: update,
  unpause: update,
};
