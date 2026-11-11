// Api::Internal::Admin::StripeRestraintNoticesController#create: the per-actor token check and StripeRestraintNoticeService's
// validation and account lookup, which refuse before anything is read for a notice. A request that resolves a live seller (a dry-run
// preview renders the mailer, a real one writes a comment and queues the mail) goes to Rails whole.
import { db } from "../../../lib/db.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";

import { failure, halted, requirePerActorToken, type AdminRequest } from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/services/stripe_restraint_notice_service.rb";
const STRIPE_ACCOUNT_ID_FORMAT = /^acct_[A-Za-z0-9]{1,100}$/u;
const FIRM_EMAIL_FORMAT =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const NOTICE_KEY_FORMAT = /^[\x21-\x7E]{1,200}$/u;
const MAX_FIRM_NAME_LENGTH = 200;
const MAX_FIRM_EMAIL_LENGTH = 254;
// Line breaks and invisible formatting characters such as bidi overrides.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

// string_param
const stringParam = (value: unknown) => (typeof value === "string" ? value : "");

// `params.key?(:dry_run) && cast(params[:dry_run]) == false`
const sendRequested = (params: AdminRequest["params"]) =>
  "dry_run" in params &&
  (params.dry_run === false ||
    params.dry_run === 0 ||
    (typeof params.dry_run === "string" && FALSE_VALUES.has(params.dry_run)));

// StripeRestraintNoticeService#validate!, then #resolve_user up to the seller it would mail
async function refusal(admin: AdminRequest): Promise<ReturnType<typeof failure> | null> {
  const accountId = rubyStrip(stringParam(admin.params.stripe_account_id));
  const firmName = rubyStrip(stringParam(admin.params.firm_name));
  const firmEmail = rubyStrip(stringParam(admin.params.firm_email));
  const noticeKey = stringParam(admin.params.notice_key);
  if (!STRIPE_ACCOUNT_ID_FORMAT.test(accountId))
    return failure("stripe_account_id must be a Stripe account id (acct_...)", 422);
  if (firmName === "") return failure("firm_name is required", 422);
  if ([...firmName].length > MAX_FIRM_NAME_LENGTH) return failure("firm_name is too long", 422);
  if (UNSAFE_CHARACTERS.test(firmName)) return failure("firm_name contains control characters", 422);
  if ([...firmEmail].length > MAX_FIRM_EMAIL_LENGTH || !FIRM_EMAIL_FORMAT.test(firmEmail))
    return failure("firm_email must be a single email address", 422);
  if (!NOTICE_KEY_FORMAT.test(noticeKey))
    return failure("notice_key must be 1-200 printable characters without spaces", 422);

  // The column's collation ignores case; Stripe ids do not.
  const accounts = await db.merchantAccount.findMany({
    where: { charge_processor_id: "stripe", charge_processor_merchant_id: accountId },
    select: { charge_processor_merchant_id: true, user_id: true },
  });
  const ownerIds = [
    ...new Set(
      accounts
        .filter((row) => row.charge_processor_merchant_id === accountId && row.user_id !== null)
        .map((row) => row.user_id!),
    ),
  ];
  if (ownerIds.length === 0) return failure(`No Gumroad account uses Stripe account ${accountId}`, 404);
  const live = await db.user.count({ where: { id: { in: ownerIds }, deleted_at: null } });
  if (live === 0) return failure(`The Gumroad account for ${accountId} is deleted`, 422);
  if (live > 1) return failure(`Stripe account ${accountId} belongs to more than one live Gumroad account`, 409);
  return null;
}

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/stripe_restraint_notices",
  // A dry run writes nothing, so it skips the token's usage stamp too.
  recordsUse: sendRequested,
  run: async (admin) => {
    const unauthorized = requirePerActorToken(admin.admin);
    if (unauthorized !== null) return halted(unauthorized);
    const refused = await refusal(admin);
    if (refused !== null) return refused;
    return handBack("a seller notice for a court order", SOURCE);
  },
});
