// Port of app/sidekiq/analyze_file_worker.rb up to the file analysis. `return if Rails.env.test?` finishes the job in test; elsewhere the
// class name is constantized and the file is analyzed (an S3 read and writes), which hand back to Rails before anything is read.
// Golden: __fixtures__/analyze-file-worker.golden.json (scripts/golden/analyze-file-worker.rb).
import { railsEnv } from "../../server/infra/rails-env.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { modelJob } from "./support/job-deps.ts";

export const analyzeFileWorkerWith = modelJob({ min: 1, max: 2 }, () => {
  if (railsEnv() === "test") return Promise.resolve();

  return Promise.reject(new HandBackToRuby("the file is analyzed from storage"));
});
export const analyzeFileWorker = analyzeFileWorkerWith();
