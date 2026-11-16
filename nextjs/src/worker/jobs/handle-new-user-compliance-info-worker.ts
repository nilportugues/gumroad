// Port of the lookup of app/sidekiq/handle_new_user_compliance_info_worker.rb: a compliance info that no longer exists raises
// RecordNotFound, as in Rails. One that does goes to StripeMerchantAccountManager.handle_new_user_compliance_info (Stripe account
// creation and updates), which stays with Rails: the job is handed back right after the read.
// Golden: __fixtures__/handle-new-user-compliance-info-worker.golden.json (scripts/golden/handle-new-user-compliance-info-worker.rb); the
// manager was replaced by a recorder there.
import type { UserComplianceInfo } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const handleNewUserComplianceInfoWorkerWith = modelJob({ min: 1 }, async ([userComplianceInfoId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userComplianceInfoId, "UserComplianceInfo.find"));
  await findByIdBang<UserComplianceInfo>("UserComplianceInfo", id);

  throw new HandBackToRuby("StripeMerchantAccountManager.handle_new_user_compliance_info is not ported");
});

export const handleNewUserComplianceInfoWorker = handleNewUserComplianceInfoWorkerWith();
