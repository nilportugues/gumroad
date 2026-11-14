// Replays analyze-file-worker.golden.json (scripts/golden/analyze-file-worker.rb): the job run by the real app as a Sidekiq job in each
// Rails environment. Node finishes in test without touching the database or Redis, and hands every other environment back before the
// file is analyzed; a wrong argument count fails as Ruby's ArgumentError does.
import { afterAll, beforeAll, describe } from "vitest";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { analyzeFileWorkerWith } from "./analyze-file-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/analyze-file-worker.golden.json", import.meta.url));
const envOf = (c: JobCase) => (c as JobCase & { rails_env: string }).rails_env;
const validArity = (c: JobCase) => c.args.length >= 1 && c.args.length <= 2;

for (const env of [...new Set(golden.cases.map(envOf))]) {
  describe(`in ${env}`, () => {
    let original: string | undefined;
    beforeAll(() => {
      original = process.env.RAILS_ENV;
      process.env.RAILS_ENV = env;
    });
    afterAll(() => {
      if (original === undefined) delete process.env.RAILS_ENV;
      else process.env.RAILS_ENV = original;
    });
    replayJobGolden(
      "AnalyzeFileWorker",
      { now: golden.now, cases: golden.cases.filter((c) => envOf(c) === env) },
      analyzeFileWorkerWith(),
      (c) => env !== "test" && validArity(c),
    );
  });
}
