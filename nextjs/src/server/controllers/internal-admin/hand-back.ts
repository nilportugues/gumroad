import { NotPortedError } from "../../models/user.ts";

// The rest of an action Node does not carry: the whole request goes to Rails before anything is written.
export const handBack = (reason: string, source: string): Promise<never> =>
  Promise.reject(new NotPortedError(reason, source));
