// app/policies/workflow_policy.rb (the Posts section)
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

function create(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const workflowPolicy = {
  index,
  create,
  new: create,
  edit: create,
  show: create,
  emails: create,
  update: create,
  createPostAndRule: create,
  createAndPublishPostAndRule: create,
  delete: create,
  destroy: create,
  saveInstallments: create,
};
