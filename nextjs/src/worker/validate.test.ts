import { describe, expect, it } from "vitest";

import { PORTED_JOBS } from "../server/jobs/ported-jobs.ts";
import { validatePortedJobs } from "./index.ts";
import { JOB_HANDLERS } from "./jobs/index.ts";

describe("validatePortedJobs", () => {
  it("accepts every ported job and its handler", () => {
    expect(() => validatePortedJobs(PORTED_JOBS, JOB_HANDLERS)).not.toThrow();
  });

  it("refuses a job whose sidekiq_retries_exhausted hook has no Node counterpart", () => {
    // Still Ruby-owned, so the runtime check fires too; the hook check is the one under test.
    expect(() => validatePortedJobs(["HandleNewBankAccountWorker"], { HandleNewBankAccountWorker: async () => {} })).toThrow(
      /HandleNewBankAccountWorker defines sidekiq_retries_exhausted; port it into JOB_RETRIES_EXHAUSTED/u,
    );
  });
});
