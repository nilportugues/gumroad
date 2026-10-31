// Contract owned by WS-05. Job names are the Ruby class names in app/sidekiq; WS-05 replaces
// `string` with a generated union once the registry exists.
export type EnqueueOptions = {
  queue?: string;
  // Absolute time, mirroring `perform_at`; use `delaySeconds` for `perform_in`.
  at?: Date;
  delaySeconds?: number;
};

export async function enqueue(jobClass: string, args: unknown[], options: EnqueueOptions = {}): Promise<void> {
  void jobClass;
  void args;
  void options;
  throw new Error("enqueue is not implemented yet (WS-05)");
}
