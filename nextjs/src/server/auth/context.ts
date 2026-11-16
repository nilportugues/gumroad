// Contract owned by WS-03. Other workstreams import this; keep the signature stable.
import type { User } from "@prisma/client";
import { cookies } from "next/headers";
import { cache } from "react";

import { railsCookieSecrets, railsSessionCookieName } from "./rails-session-config.ts";
import { resolveAuth } from "./resolve.ts";
import { prismaAuthStore } from "./store.ts";

export { railsLoggedInUser } from "./resolve.ts";

export type RequestContext = {
  // The person behind the session (an admin while impersonating).
  loggedInUser: User | null;
  // Whose account is being acted on: differs from loggedInUser for team members and impersonation.
  currentSeller: User | null;
  impersonatedUser: User | null;
};

// The Rails session cookie is the source of truth while login lives in Rails: logging out there
// logs out here on the next request. Note that Rails' `logged_in_user` is
// `railsLoggedInUser(context)`, not `context.loggedInUser`, which is Rails' `current_user`.
export async function getRequestContext(): Promise<RequestContext> {
  return resolvePerRequest();
}

// React's cache() scopes this to one server render; outside a render it simply runs each time.
const resolvePerRequest = cache(async (): Promise<RequestContext> => {
  const jar = await cookies();
  const { context } = await resolveAuth({
    cookies: { get: (name) => jar.get(name)?.value },
    secrets: railsCookieSecrets(),
    sessionCookieName: railsSessionCookieName(),
    store: prismaAuthStore,
  });
  return context;
});
