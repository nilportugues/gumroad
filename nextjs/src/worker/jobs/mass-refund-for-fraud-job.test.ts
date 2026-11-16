// Replays mass-refund-for-fraud-job.golden.json (scripts/golden/mass-refund-for-fraud-job.rb): the job run by the real app as a Sidekiq
// job. Node sends the `purchases` read Rails sent for each external id (`id IS NULL` for one that does not decrypt) and finishes when no
// purchase belongs to the product; the first purchase of the product is handed back before the refund.
import { afterAll, beforeAll } from "vitest";

import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { massRefundForFraudJobWith } from "./mass-refund-for-fraud-job.ts";

const golden = loadGolden(new URL("./__fixtures__/mass-refund-for-fraud-job.golden.json", import.meta.url));

// Arguments Ruby treats differently from Node: a product id that is not an Integer (`link_id == 1.0` is true, `== "1"` false) and
// external ids that are not a list of strings (`nil.each` raises). Node hands those back before reading anything.
const handsBackEarly = (c: { args: unknown[] }) => {
  if (c.args.length !== 3) return false;
  const [productId, externalIds] = c.args;
  return (
    !(typeof productId === "number" && Number.isInteger(productId)) ||
    !Array.isArray(externalIds) ||
    !externalIds.every((externalId) => typeof externalId === "string")
  );
};

const KEYS = { OBFUSCATE_IDS_CIPHER_KEY: "test-cipher-key", OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "123456789" };
const original = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, KEYS);
});
afterAll(() => {
  for (const name of Object.keys(KEYS)) {
    const previous = original[name];
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  }
});

replayJobGolden("MassRefundForFraudJob", golden, massRefundForFraudJobWith(), handsBackEarly);
