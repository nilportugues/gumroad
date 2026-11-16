export type SidekiqOptionValue = string | number | boolean | null | { readonly [key: string]: SidekiqOptionValue };

export type JobDefinition = {
  readonly file: string;
  // `OldName = NewName` in app/sidekiq: Ruby pushes the target's class name, so Node does too.
  readonly aliasOf?: string;
  // False for a class in app/sidekiq that does not include Sidekiq::Job (cron still pushes it
  // with Sidekiq's default options).
  readonly sidekiqJob: boolean;
  // The class's own `sidekiq_options`, in declaration order, before Sidekiq.default_job_options.
  readonly options: { readonly [key: string]: SidekiqOptionValue };
  readonly customLockArgs: boolean;
  // `sidekiq_retry_in`: a Node port has to carry the block over as its BullMQ backoff by hand.
  readonly customRetryIn: boolean;
  readonly retriesExhausted: boolean;
  readonly recurringLockMaxAttempt?: number;
  readonly runtime: "ruby" | "node";
};

export type CronDefinition = {
  readonly name: string;
  readonly cron: string;
  readonly class: string;
  readonly queue?: string;
  readonly args?: readonly unknown[];
  readonly description?: string;
};
