// Port of app/sidekiq/product_build_unpack_job.rb up to the unpack. `ProductBuild.find_by(id:)` runs in Node and a missing build
// returns; a build is unpacked from object storage, which hands back before any of it. Golden:
// __fixtures__/product-build-unpack-job.golden.json (scripts/golden/product-build-unpack-job.rb).
import type { ProductBuild } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const productBuildUnpackJobWith = modelJob({ min: 1 }, async ([buildId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(buildId, "ProductBuild.find_by"));
  const build = await findById<ProductBuild>("ProductBuild", id);
  if (build === null) return;

  throw new HandBackToRuby("the build is unpacked from object storage");
});
export const productBuildUnpackJob = productBuildUnpackJobWith();
