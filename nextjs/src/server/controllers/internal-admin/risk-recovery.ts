// Api::Internal::Admin::StrandedBuyersController#recover and LowBalanceProbationRecoveriesController#preview/#execute. Both clear
// fraud enforcement through services Node does not carry, so they answer the per-actor token check and the parameter refusals and
// hand every other request back before a write. (The stranded-buyer scan and the recovery services are not ported.)
import { rubyStrip } from "../../content-moderation/ruby.ts";

import { failure, halted, paramToS, recordAdminWrite, requirePerActorToken, type AdminRequest } from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";

const STRANDED_SOURCE = "app/controllers/api/internal/admin/stranded_buyers_controller.rb";
const LOW_BALANCE_SOURCE = "app/controllers/api/internal/admin/low_balance_probation_recoveries_controller.rb";
const MAX_ACCOUNTS = 25;
const WRAPPER = { key: "low_balance_probation_recovery" };

// requested_external_ids: the refusal, or null for a list that clears the checks.
function userIdsRefusal(admin: AdminRequest): ReturnType<typeof failure> | null {
  const raw = admin.params.user_ids;
  const ids = Array.isArray(raw) ? raw.map((item) => rubyStrip(paramToS(item, LOW_BALANCE_SOURCE))) : [];
  const message =
    ids.length === 0 || ids.some((id) => id === "")
      ? "user_ids is required"
      : ids.length > MAX_ACCOUNTS
        ? `at most ${MAX_ACCOUNTS} user_ids per request`
        : new Set(ids).size !== ids.length
          ? "user_ids must not repeat"
          : null;
  return message === null ? null : failure(message, 400);
}

const lowBalance = (action: string, service: string) => (admin: AdminRequest) => {
  const unauthorized = requirePerActorToken(admin.admin);
  if (unauthorized !== null) return Promise.resolve(halted(unauthorized));
  return recordAdminWrite(admin, { action, target: null, wrapper: WRAPPER }, () => {
    const refusal = userIdsRefusal(admin);
    return refusal !== null ? Promise.resolve(refusal) : handBack(service, LOW_BALANCE_SOURCE);
  });
};

defineAdminRoute(
  {
    method: "POST",
    pattern: "/internal/admin/stranded_buyers/recover",
    run: (admin) => {
      const unauthorized = requirePerActorToken(admin.admin);
      if (unauthorized !== null) return Promise.resolve(halted(unauthorized));
      if (
        rubyStrip(paramToS(admin.params.email, STRANDED_SOURCE)) === "" &&
        rubyStrip(paramToS(admin.params.user_id, STRANDED_SOURCE)) === ""
      )
        return Promise.resolve(failure("email or user_id is required", 400));
      return handBack("the stranded-buyer recovery", STRANDED_SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/low_balance_probation_recoveries/preview",
    run: lowBalance("low_balance_probation_recoveries.preview", "the signed probation snapshot"),
  },
  {
    method: "POST",
    pattern: "/internal/admin/low_balance_probation_recoveries/execute",
    run: lowBalance("low_balance_probation_recoveries.execute", "the probation recovery"),
  },
);
