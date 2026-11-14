import { HandBackToRuby } from "../../../server/jobs/hand-back.ts";

// Rails reports a Redis error and goes on without it; that report is not Node's to make, and nothing has been written before a
// failed command that precedes the job's one write, so Rails runs the job whole.
export async function redisOrHandBack<T>(what: string, command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch {
    throw new HandBackToRuby(`${what} failed`);
  }
}
