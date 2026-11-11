// app/policies/checkout/offer_code_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

type OwnedRecord = { user_id: number | bigint };

const ownedBySeller = (context: SellerContext, record: OwnedRecord) => context.seller !== null && BigInt(record.user_id) === BigInt(context.seller.id);

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

function create(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const checkoutOfferCodePolicy = {
  index,
  paged: index,
  statistics: (context: SellerContext, record: OwnedRecord) => index(context) && ownedBySeller(context, record),
  create,
  update: (context: SellerContext, record: OwnedRecord) => create(context) && ownedBySeller(context, record),
};
