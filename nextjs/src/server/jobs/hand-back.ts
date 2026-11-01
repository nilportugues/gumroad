// A ported job that meets a case Node can't run yet hands the whole job to Rails' Sidekiq, which
// still has the Ruby class. Only safe before the job has written anything: Rails runs it from the
// start. The worker pushes the original item to its Sidekiq queue and completes the BullMQ job.
export class HandBackToRuby extends Error {
  constructor(reason: string) {
    super(`Handed back to Rails: ${reason}`);
    this.name = "HandBackToRuby";
  }
}

// Turns a NotPortedError raised by `checks` into a hand-back. Wrap only argument checks and reads
// that run before the job's first write.
export async function beforeSideEffects<T>(checks: () => T | Promise<T>): Promise<T> {
  try {
    return await checks();
  } catch (error) {
    if (error instanceof Error && error.name === "NotPortedError") throw new HandBackToRuby(error.message);
    throw error;
  }
}
