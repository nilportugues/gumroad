// Replays product-build-unpack-job.golden.json (scripts/golden/product-build-unpack-job.rb): the job run by the real app as a Sidekiq
// job. Node sends the one `product_builds` read Rails sent, returns for a missing build and hands a build back before the unpack.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { productBuildUnpackJobWith } from "./product-build-unpack-job.ts";

const golden = loadGolden(new URL("./__fixtures__/product-build-unpack-job.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil (find_by), casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "ProductBuildUnpackJob",
  golden,
  productBuildUnpackJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);
