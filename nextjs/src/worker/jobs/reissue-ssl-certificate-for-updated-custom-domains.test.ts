// Replays reissue-ssl-certificate-for-updated-custom-domains.golden.json (scripts/golden/reissue-ssl-certificate-for-updated-custom-domains.rb):
// the job run by the real app as a Sidekiq job. Node sends the statements Rails sent for a sweep with no alive domain that holds a
// certificate, and hands back, after the same statement, a sweep with one.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { reissueSslCertificateForUpdatedCustomDomainsWith } from "./reissue-ssl-certificate-for-updated-custom-domains.ts";

const golden = loadGolden(
  new URL("./__fixtures__/reissue-ssl-certificate-for-updated-custom-domains.golden.json", import.meta.url),
);

replayJobGolden(
  "ReissueSslCertificateForUpdatedCustomDomains",
  golden,
  reissueSslCertificateForUpdatedCustomDomainsWith(),
);
