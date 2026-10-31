// Stand-in for server/auth/context.ts while WS-03 is unmerged, swapped in by next.config.ts when
// NEXTJS_SIGNED_OUT_CONTEXT=1. Lets converted pages render locally as a signed-out visitor.
import type { RequestContext } from "@/server/auth/context";

export type { RequestContext };

export async function getRequestContext(): Promise<RequestContext> {
  return { loggedInUser: null, currentSeller: null, impersonatedUser: null };
}
