// Port of app/models/global_affiliate.rb as User's `after_create :create_global_affiliate!` runs it: a fresh account's row in the Gumroad
// affiliate program. Only the create path exists; nothing else in Node writes an affiliate yet.
import type { Affiliate } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";

// GlobalAffiliate::AFFILIATE_BASIS_POINTS
export const GLOBAL_AFFILIATE_BASIS_POINTS = 1000;
const TYPE = "GlobalAffiliate";

const AFFILIATE_USER: BelongsTo = {
  name: "affiliate_user",
  foreignKey: "affiliate_user_id",
  targetTable: "users",
  targetModel: "User",
};

export const GlobalAffiliates = defineModel<Affiliate>({
  rubyClass: TYPE,
  prismaModel: "Affiliate",
  delegate: (tx) => tx.affiliate as never,
  beforeValidation: [
    {
      name: "set_affiliate_basis_points",
      unless: (r) => r.persisted,
      run: (r) => {
        r.set("affiliate_basis_points", GLOBAL_AFFILIATE_BASIS_POINTS);
      },
    },
  ],
  validations: [
    // belongs_to :affiliate_user
    belongsToRequired<Affiliate>(AFFILIATE_USER),
    // Affiliate#eligible_for_stripe_payments: a brand-new account has no merchant account to be Brazilian.
    // GlobalAffiliate: validates :affiliate_user_id, uniqueness: true
    validatesUniquenessOf<Affiliate>("affiliates", ["affiliate_user_id"], {}),
    validatesPresenceOf<Affiliate>(["affiliate_basis_points"], {}),
  ],
});

export const globalAffiliateAttributes = (affiliateUserId: bigint | number): Partial<Affiliate> => ({
  affiliate_user_id: Number(affiliateUserId),
  type: TYPE,
});
