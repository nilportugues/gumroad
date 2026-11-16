// S3UtilityPolicy and DropboxFilesPolicy (app/policies): the product editor's uploads, for admins and marketing.
import { requireUser, roleAdminFor, roleMarketingFor, type SellerContext } from "./seller-context.ts";

function adminOrMarketing(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const s3UtilityPolicy = { generate_multipart_signature: adminOrMarketing, current_utc_time_string: adminOrMarketing, cdn_url_for_blob: adminOrMarketing };
export const dropboxFilesPolicy = { create: adminOrMarketing, index: adminOrMarketing, cancel_upload: adminOrMarketing };
