// Replays retry-stripe-rejected-payout-setup-for-seller-job.golden.json (scripts/golden/retry-stripe-rejected-payout-setup-for-seller-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the statements Rails sent and ends where Rails ends without a write; a seller
// with an outstanding note (or notes to abandon) goes back before the first write, and so does a note whose json_data is not a hash:
// Rails raises into its ErrorNotifier rescue there and ends quietly, which Node cannot report.
import { beforeAll, describe, vi } from "vitest";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { retryStripeRejectedPayoutSetupForSellerJobWith } from "./retry-stripe-rejected-payout-setup-for-seller-job.ts";

// The recording turns the merchant_migration Flipper feature on for some cases (`merchant_migration`); Node reads it from Redis, so it is stubbed.
const flipper = vi.hoisted(() => ({ merchantMigration: false }));
vi.mock("../../server/infra/flipper.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/infra/flipper.ts")>()),
  isFeatureEnabled: () => Promise.resolve(flipper.merchantMigration),
}));

type FlagCase = JobCase & { merchant_migration: boolean };

const golden = loadGolden(new URL("./__fixtures__/retry-stripe-rejected-payout-setup-for-seller-job.golden.json", import.meta.url));

const NOT_A_HASH = /holding (json that is not json|a json array|a json string|a json number)/u;
// Rails ends these without a write, but only after a read Node does not port: the payout email of a PayPal merchant account and the
// Connect routing country of a seller on merchant_migration.
const UNPORTED_READ = /^a seller with (the merchant migration feature on and no notes|a PayPal merchant account and no notes)$/u;
const cases = golden.cases.map((c) => (NOT_A_HASH.test(c.name) || UNPORTED_READ.test(c.name) ? { ...c, hands_back: true } : c));

// Rails casts a word to NULL and a float to an integer; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

for (const migration of [false, true]) {
  describe(`merchant_migration ${migration ? "on" : "off"}`, () => {
    beforeAll(() => {
      flipper.merchantMigration = migration;
    });
    replayJobGolden(
      "RetryStripeRejectedPayoutSetupForSellerJob",
      { now: golden.now, cases: cases.filter((c) => (c as FlagCase).merchant_migration === migration) },
      retryStripeRejectedPayoutSetupForSellerJobWith(),
      (c) => c.args.length === 1 && castByRails(c.args[0]),
    );
  });
}
