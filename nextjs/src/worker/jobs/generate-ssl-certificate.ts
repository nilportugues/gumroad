// Port of app/sidekiq/generate_ssl_certificate.rb up to the ACME order. `supported_environment?` finishes the job anywhere but production
// (or staging outside a branch deployment); there the domain is found in Node, a deleted one finishes the job, and any other builds
// SslCertificates::Generate (S3, DNS and the ACME order with its rate-limit reschedule), which hands back to Rails before any write.
// An id Rails casts goes back before any read.
// Golden: __fixtures__/generate-ssl-certificate.golden.json (scripts/golden/generate-ssl-certificate.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import type { RetriesExhausted } from "../retry.ts";

import { supportedEnvironment } from "./renew-custom-domain-ssl-certificates.ts";
import { modelJob } from "./support/job-deps.ts";

export const generateSslCertificateWith = modelJob({ min: 1, max: 2 }, async ([id]) => {
  if (!supportedEnvironment()) return;

  const domainId = await beforeSideEffects(() => recordIdFrom(id, "CustomDomain.find"));
  const domain = await findByIdBang<{ deleted_at: Date | null }>("CustomDomain", domainId);
  // The domain was deleted after this job was enqueued.
  if (domain.deleted_at !== null) return;

  throw new HandBackToRuby("the SSL certificate is ordered from the ACME server");
});
export const generateSslCertificate = generateSslCertificateWith();

// The exhausted block reads `CustomDomain.find_by` and reports to ErrorNotifier (Sentry), which no recording here can compare, so it goes
// back whole: Rails makes one last attempt and then runs its own block.
export const generateSslCertificateRetriesExhausted: RetriesExhausted = () => {
  throw new HandBackToRuby("the retries-exhausted block reports to ErrorNotifier");
};
