// Port of app/sidekiq/renew_custom_domain_ssl_certificates.rb up to SslCertificates::Renew. `supported_environment?` (production, or
// staging outside a branch deployment) finishes the job anywhere else; a supported environment builds the renewer (S3, DNS and the
// ACME order), which hands back to Rails before anything is read or written.
// Golden: __fixtures__/renew-custom-domain-ssl-certificates.golden.json (scripts/golden/renew-custom-domain-ssl-certificates.rb).
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { modelJob } from "./support/job-deps.ts";

// Ruby tests `ENV["BRANCH_DEPLOYMENT"]` for nil only, so an empty value still counts as a branch deployment.
const supportedEnvironment = () =>
  railsEnv() === "production" || (railsEnv() === "staging" && process.env.BRANCH_DEPLOYMENT === undefined);

export const renewCustomDomainSslCertificatesWith = modelJob({ min: 0 }, () => {
  if (!supportedEnvironment()) return Promise.resolve();

  return Promise.reject(new HandBackToRuby("the custom domain certificate renewal"));
});
export const renewCustomDomainSslCertificates = renewCustomDomainSslCertificatesWith();
