// Replays generate-product-files-archives-job.golden.json (scripts/golden/generate-product-files-archives-job.rb): the job run by the
// real app as a Sidekiq job. Node sends the one `links` read Rails sent for a missing or deleted product, and hands a live product back
// before the lock.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { generateProductFilesArchivesJobWith } from "./generate-product-files-archives-job.ts";

const golden = loadGolden(new URL("./__fixtures__/generate-product-files-archives-job.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("GenerateProductFilesArchivesJob", golden, generateProductFilesArchivesJobWith(), (c) =>
  castByRails(c.args[0]),
);
