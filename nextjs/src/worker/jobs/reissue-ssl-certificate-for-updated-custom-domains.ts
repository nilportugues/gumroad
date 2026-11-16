// Port of app/sidekiq/reissue_ssl_certificate_for_updated_custom_domains.rb up to the first domain. The scan of alive domains that hold
// a certificate runs in Node and finishes an empty one. A domain in it needs DNS lookups, the ACME order and a `reset_ssl_certificate_issued_at!`
// write, so the whole sweep goes back to Rails before any of that.
// Golden: __fixtures__/reissue-ssl-certificate-for-updated-custom-domains.golden.json
// (scripts/golden/reissue-ssl-certificate-for-updated-custom-domains.rb).
import { Prisma, type CustomDomain } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const CUSTOM_DOMAINS = "custom_domains";
const FIND_EACH_BATCH_SIZE = 1_000;

export const reissueSslCertificateForUpdatedCustomDomainsWith = modelJob({ min: 0, max: 0 }, async () => {
  // `CustomDomain.alive.where.not(ssl_certificate_issued_at: nil).find_each`
  await findInBatches<CustomDomain>(
    CUSTOM_DOMAINS,
    Prisma.sql`${column(CUSTOM_DOMAINS, "deleted_at")} IS NULL AND ${column(CUSTOM_DOMAINS, "ssl_certificate_issued_at")} IS NOT NULL`,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a custom domain with a certificate to check");
    },
  );
});
export const reissueSslCertificateForUpdatedCustomDomains = reissueSslCertificateForUpdatedCustomDomainsWith();
