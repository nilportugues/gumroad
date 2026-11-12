// Replays renew-custom-domain-ssl-certificates.golden.json (scripts/golden/renew-custom-domain-ssl-certificates.rb): the job run by the
// real app as a Sidekiq job in each Rails environment, with BRANCH_DEPLOYMENT unset, empty and set. Node finishes where the environment
// is not supported without touching anything, and hands a supported one back before the renewer is built.
import { afterAll, beforeAll, describe } from "vitest";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { renewCustomDomainSslCertificatesWith } from "./renew-custom-domain-ssl-certificates.ts";

type EnvCase = JobCase & { rails_env: string; branch_deployment: string | null };

const golden = loadGolden(new URL("./__fixtures__/renew-custom-domain-ssl-certificates.golden.json", import.meta.url));
const envOf = (c: JobCase) => c as EnvCase;
const key = (c: JobCase) => `${envOf(c).rails_env} / BRANCH_DEPLOYMENT ${JSON.stringify(envOf(c).branch_deployment)}`;

for (const group of [...new Set(golden.cases.map(key))]) {
  const cases = golden.cases.filter((c) => key(c) === group);
  describe(group, () => {
    const original = { railsEnv: process.env.RAILS_ENV, branch: process.env.BRANCH_DEPLOYMENT };
    beforeAll(() => {
      process.env.RAILS_ENV = envOf(cases[0]!).rails_env;
      const branch = envOf(cases[0]!).branch_deployment;
      if (branch === null) delete process.env.BRANCH_DEPLOYMENT;
      else process.env.BRANCH_DEPLOYMENT = branch;
    });
    afterAll(() => {
      if (original.railsEnv === undefined) delete process.env.RAILS_ENV;
      else process.env.RAILS_ENV = original.railsEnv;
      if (original.branch === undefined) delete process.env.BRANCH_DEPLOYMENT;
      else process.env.BRANCH_DEPLOYMENT = original.branch;
    });
    replayJobGolden(
      "RenewCustomDomainSslCertificates",
      { now: golden.now, cases },
      renewCustomDomainSslCertificatesWith(),
      (c) => c.hands_back === true,
    );
  });
}
