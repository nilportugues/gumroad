import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

export type JobContext = {
  jid: string;
  // The full Sidekiq-shaped job hash, for jobs that read `job["args"]` or retry counts in Ruby.
  item: SidekiqItem;
  // 0 on the first run, like Sidekiq's `retry_count` being absent.
  attemptsMade: number;
};

// `perform(*args)`. Throwing schedules a retry with Sidekiq's backoff.
export type JobHandler = (args: JsonValue[], context: JobContext) => Promise<void>;
