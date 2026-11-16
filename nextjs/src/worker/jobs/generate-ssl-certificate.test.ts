// Replays generate-ssl-certificate.golden.json (scripts/golden/generate-ssl-certificate.rb): GenerateSslCertificate run by the real app as
// a Sidekiq job in each Rails environment. Node finishes where the environment is not supported without a read, sends the
// `CustomDomain.find` Rails sent where it is, ends a missing or deleted domain as Rails did, and hands a live one back before the order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids } from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { generateSslCertificateRetriesExhausted, generateSslCertificateWith } from "./generate-ssl-certificate.ts";

type EnvCase = JobCase & { rails_env: string; branch_deployment: string | null };

const golden = loadGolden(new URL("./__fixtures__/generate-ssl-certificate.golden.json", import.meta.url));
const envOf = (c: JobCase) => c as EnvCase;
const key = (c: JobCase) => `${envOf(c).rails_env} / BRANCH_DEPLOYMENT ${JSON.stringify(envOf(c).branch_deployment)}`;

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const supported = (c: JobCase) =>
  envOf(c).rails_env === "production" || (envOf(c).rails_env === "staging" && envOf(c).branch_deployment === null);

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
      "GenerateSslCertificate",
      { now: golden.now, cases },
      generateSslCertificateWith(),
      (c) => supported(c) && c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
    );
  });
}

// The exhausted block is not recorded (it ends in ErrorNotifier); it must hand back before any read or push.
describe("GenerateSslCertificate retries exhausted", () => {
  it("hands back whole without a read or a push", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      Promise.resolve().then(() =>
        generateSslCertificateRetriesExhausted({ args: [1], jid: "j" } as never, new Error("boom"), { runtime }),
      ),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(recording.snapshot()).toEqual({});
  });
});
