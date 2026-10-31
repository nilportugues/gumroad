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

// The runtime enqueues from this call stack go through: the job's inside a handler, else the process's.
export function currentJobsRuntime(): JobsRuntime {
  return storage.getStore() ?? jobsRuntime();
}

// The jid, or null where `perform_async` returns nil (a unique lock dropped the push).
export function performAsync(jobClass: string, args: JsonValue[], options?: EnqueueOptions): Promise<string | null> {
  return enqueueWith(storage.getStore() ?? jobsRuntime(), jobClass, args, options);
}

// `FooJob.perform_bulk(args_list)` (Sidekiq 7.3 push_bulk): normalize_item draws a jid it never
// uses, even for an empty list, then every job gets its own jid and passes the client middleware.
// One LPUSH of them all leaves Redis as one LPUSH each does, so they go through performAsync.
export async function performBulk(jobClass: string, argsList: JsonValue[][]): Promise<(string | null)[]> {
  const runtime = storage.getStore() ?? jobsRuntime();
  runtime.newJid();
  const jids: (string | null)[] = [];
  for (const args of argsList) jids.push(await enqueueWith(runtime, jobClass, args));
  return jids;
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
