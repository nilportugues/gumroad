// Port of app/sidekiq/custom_domains_verification_worker.rb: every alive custom domain that has not used up its failed verification
// attempts gets a CustomDomainVerificationWorker, spread over an hour by its position among all alive domains (skipped ones included).
// Golden: __fixtures__/custom-domains-verification-worker.golden.json (scripts/golden/custom-domains-verification-worker.rb).
import { Prisma, type CustomDomain } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const CUSTOM_DOMAINS = "custom_domains";
const BATCH_SIZE = 1_000;
// CustomDomainsVerificationWorker::MAX_DURATION_TO_VERIFY_ALL_DOMAINS, in seconds
const VERIFY_ALL_WITHIN_SECONDS = 60 * 60;
// CustomDomain::MAX_FAILED_VERIFICATION_ATTEMPTS_COUNT
const MAX_FAILED_VERIFICATION_ATTEMPTS = 3;

export const customDomainsVerificationWorkerWith = modelJob({ min: 0, max: 0 }, async () => {
  let index = 0;
  // `CustomDomain.alive.find_each.with_index`
  await findInBatches<CustomDomain>(
    CUSTOM_DOMAINS,
    Prisma.sql`${column(CUSTOM_DOMAINS, "deleted_at")} IS NULL`,
    BATCH_SIZE,
    async (batch) => {
      for (const domain of batch) {
        const position = index++;
        if (domain.failed_verification_attempts_count >= MAX_FAILED_VERIFICATION_ATTEMPTS) continue;
        await performAsync("CustomDomainVerificationWorker", [domain.id], {
          delaySeconds: position % VERIFY_ALL_WITHIN_SECONDS,
        });
      }
    },
  );
});

export const customDomainsVerificationWorker = customDomainsVerificationWorkerWith();
