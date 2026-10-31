// Contract owned by WS-03. Other workstreams import this; keep the signature stable.
import type { User } from "@prisma/client";

export type RequestContext = {
  // The person behind the session (an admin while impersonating).
  loggedInUser: User | null;
  // Whose account is being acted on: differs from loggedInUser for team members and impersonation.
  currentSeller: User | null;
  impersonatedUser: User | null;
};

export async function getRequestContext(): Promise<RequestContext> {
  throw new Error("getRequestContext is not implemented yet (WS-03)");
}
