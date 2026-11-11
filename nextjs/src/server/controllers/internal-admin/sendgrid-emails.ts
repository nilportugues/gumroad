// Api::Internal::Admin::SendgridEmailsController. The SendGrid API calls are Rails'; Node answers the parameter refusals in front of them
// and hands every other request back before anything is written.
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank } from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/controllers/api/internal/admin/sendgrid_emails_controller.rb";
const SUPPORTED_LISTS = ["bounces", "blocks", "spam_reports", "invalid_emails"];
const EMAIL_REQUIRED = "'email' parameter is required";

// Array(params[:list]) for the shapes that stay text.
function requestedLists(list: unknown): string[] {
  if (isBlank(list) || list === "all") return SUPPORTED_LISTS;
  if (typeof list === "string") return [list];
  if (Array.isArray(list) && list.every((item) => typeof item === "string")) return list;
  throw new NotPortedError("a list that is not text", SOURCE);
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/sendgrid_emails/check_status",
    run: (admin) =>
      isBlank(admin.params.email)
        ? Promise.resolve(failure(EMAIL_REQUIRED, 400))
        : handBack("the SendGrid suppression lookup", SOURCE),
  },
  {
    method: "POST",
    pattern: "/internal/admin/sendgrid_emails/remove_suppression",
    run: (admin) => {
      if (isBlank(admin.params.email)) return Promise.resolve(failure(EMAIL_REQUIRED, 400));
      const invalid = requestedLists(admin.params.list).filter((name) => !SUPPORTED_LISTS.includes(name));
      if (invalid.length > 0) return Promise.resolve(failure(`Unsupported list(s): ${invalid.join(", ")}`, 400));
      return handBack("the SendGrid suppression removal", SOURCE);
    },
  },
);
