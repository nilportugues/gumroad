// What the model-backed job ports take from the outside world, so tests can freeze the clock and
// record ReplicaLagWatcher calls.
import { randomUUID } from "node:crypto";

import { replicaLagWatcher } from "../../../server/infra/replica-lag-watcher.ts";
import { withJobsRuntime } from "../../../server/models/concerns/job-runtime.ts";
import type { JsonValue } from "../../../server/jobs/sidekiq/ruby-json.ts";
import { checkArity } from "../arity.ts";
import type { JobContext, JobHandler } from "../types.ts";

export type JobDeps = {
  // Time.current
  now: () => Date;
  // ReplicaLagWatcher.watch
  watchReplicaLag: () => Promise<void>;
  // SecureRandom.uuid
  uuid: () => string;
};

export const defaultJobDeps: JobDeps = {
  now: () => new Date(),
  watchReplicaLag: () => replicaLagWatcher().watch(),
  uuid: () => randomUUID(),
};

// A handler whose models enqueue through the worker's runtime.
export function modelJob(
  arity: { min: number; max?: number },
  body: (args: JsonValue[], deps: JobDeps, context: JobContext) => Promise<void>,
): (deps?: Partial<JobDeps>) => JobHandler {
  return (overrides = {}) => {
    const deps = { ...defaultJobDeps, ...overrides };
    return async (args, context) => {
      checkArity(args, arity.min, arity.max ?? arity.min);
      await withJobsRuntime(context.runtime, () => body(args, deps, context));
    };
  };
}
