// `FooJob.perform_async` from model code, and AfterCommitEverywhere.after_commit. A Node job
// handler runs its body inside withJobsRuntime(context.runtime) so the enqueues its models make
// go through the worker's connections (and a test's doubles).
import { AsyncLocalStorage } from "node:async_hooks";

import { enqueueWith, type EnqueueOptions } from "../../jobs/enqueue.ts";
import { jobsRuntime, type JobsRuntime } from "../../jobs/runtime.ts";
import type { JsonValue } from "../../jobs/sidekiq/ruby-json.ts";
import { currentTransaction, participate } from "../runtime/transaction.ts";

const storage = new AsyncLocalStorage<JobsRuntime>();

export function withJobsRuntime<T>(runtime: JobsRuntime, fn: () => Promise<T>): Promise<T> {
  return storage.run(runtime, fn);
}

// The jid, or null where `perform_async` returns nil (a unique lock dropped the push).
export function performAsync(jobClass: string, args: JsonValue[], options?: EnqueueOptions): Promise<string | null> {
  return enqueueWith(storage.getStore() ?? jobsRuntime(), jobClass, args, options);
}

// after_commit_everywhere 1.4: once the outermost transaction commits, or at once outside one.
// A rolled-back transaction drops the callback.
export async function afterCommitEverywhere(fn: () => Promise<unknown>): Promise<void> {
  if (!currentTransaction()) {
    await fn();
    return;
  }
  const participant = participate({}, "update", () => ({
    commit: async () => {
      await fn();
    },
    rollback: async () => {},
    restore: () => {},
  }));
  participant.triggered = true;
}
