// Port of app/sidekiq/custom_domain_verification_worker.rb up to the DNS lookups. `CustomDomain.find`, `deleted?` and `valid?` (the
// domain checks and the owner lookups) run in Node; a valid domain is looked up in DNS and saved with its verification state, which
// hand back before `CustomDomainVerificationService.new`. Golden: __fixtures__/custom-domain-verification-worker.golden.json
// (scripts/golden/custom-domain-verification-worker.rb).
import type { CustomDomain } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { CustomDomains } from "../../server/models/custom-domain.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const customDomainVerificationWorkerWith = modelJob({ min: 1 }, async ([customDomainId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(customDomainId, "CustomDomain.find"));
  const row = await findByIdBang<CustomDomain>("CustomDomain", id);
  if (row.deleted_at !== null) return;
  if (!(await CustomDomains.validWithoutTransaction(CustomDomains.load(row)))) return;

  throw new HandBackToRuby("the domain is looked up in DNS");
});
export const customDomainVerificationWorker = customDomainVerificationWorkerWith();
