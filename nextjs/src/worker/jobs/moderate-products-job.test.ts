// Replays moderate-products-job.golden.json (scripts/golden/moderate-products-job.rb): the job run by the real app as a Sidekiq job with the
// moderation service replaced by a recorder. Node finishes the runs with nothing to check with the same statement; one that found a product
// is handed back right after the batch read, and so are ids Rails casts or reads loosely (digit strings, floats, nil, past 2**53).
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { moderateProductsJobWith } from "./moderate-products-job.ts";

const NOT_INTEGERS = new Set([
  "a product id given as a digit string",
  "a product id given as a word",
  "a product id of nil among others",
  "a single product id",
  "a product ids argument of nil",
  "an id past 2**53",
  "a product id given as a float",
]);

describeGuardedJob({
  title: "ModerateProductsJob",
  file: "moderate-products-job.golden.json",
  make: (deps) => moderateProductsJobWith(deps),
  reached: (c) => (c.processed as unknown[]).length > 0,
  castBefore: (c) => NOT_INTEGERS.has(c.name),
});
