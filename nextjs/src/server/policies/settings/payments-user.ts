// app/policies/settings/payments/user_policy.rb: `record` is the seller the page edits.
import type { User } from "@prisma/client";

import { requireUser, roleAdminFor, roleOwnerFor, type SellerContext } from "../seller-context.ts";

const show = (context: SellerContext, _record?: User) => roleAdminFor(requireUser(context));
const update = (context: SellerContext, record: User) => roleAdminFor(requireUser(context)) && record.id === context.seller?.id;
const ownerOnlyUpdate = (context: SellerContext, record: User) => roleOwnerFor(requireUser(context)) && record.id === context.seller?.id;

export const settingsPaymentsUserPolicy = {
  show,
  update,
  setCountry: update,
  optInToAuBacktaxCollection: update,
  verifyDocument: ownerOnlyUpdate,
  verifyIdentity: ownerOnlyUpdate,
  paypalConnect: update,
  stripeConnect: update,
  removeCreditCard: update,
  remediation: update,
  verifyStripeRemediation: update,
};
