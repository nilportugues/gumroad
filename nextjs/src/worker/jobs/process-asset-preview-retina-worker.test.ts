// Replays process-asset-preview-retina-worker.golden.json (scripts/golden/process-asset-preview-retina-worker.rb): the job run by the real
// app as a Sidekiq job with the retina variant builder replaced by a recorder. A missing or deleted preview is left alone with the same
// read; a live one is handed back right after it, and so is an id Rails casts (a float, a word).
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { processAssetPreviewRetinaWorkerWith } from "./process-asset-preview-retina-worker.ts";

const CAST_IDS = new Set(["a preview id given as a float", "a preview id given as a word"]);

describeGuardedJob({
  title: "ProcessAssetPreviewRetinaWorker",
  file: "process-asset-preview-retina-worker.golden.json",
  make: (deps) => processAssetPreviewRetinaWorkerWith(deps),
  reached: (c) => (c.processed as number[]).length > 0,
  castBefore: (c) => CAST_IDS.has(c.name),
});
