// app/policies/settings/authorized_applications/oauth_application_policy.rb
import { requireUser, roleAdminFor, type SellerContext } from "../seller-context.ts";

const index = (context: SellerContext) => roleAdminFor(requireUser(context));

export const settingsAuthorizedApplicationsOauthApplicationPolicy = { index, create: index, edit: index, update: index, destroy: index };
