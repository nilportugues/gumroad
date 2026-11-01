// The route gate the proxy uses in deployed environments: Flipper decides whether a converted route
// is on, and the Rails session cookie says whether the visitor is signed in. Every failure answers
// in the direction that sends the request to Rails, which can always serve it.
import type { ProxyRequestInfo, RouteGate } from "../lib/navigation/proxy/gate.ts";
import { readEncryptedCookie, readSignedCookie, type RailsCookieSecrets } from "./auth/rails-cookies.ts";
import { railsCookieSecrets, railsSessionCookieName, REMEMBER_COOKIE_NAME } from "./auth/rails-session-config.ts";
import { parseRememberCookie, wardenUserFromSession } from "./auth/warden.ts";
import { isFeatureEnabled as flipperIsFeatureEnabled, userActor } from "./infra/flipper.ts";

type Deps = {
  secrets: () => RailsCookieSecrets;
  sessionCookieName: () => string;
  isFeatureEnabled: (flag: string, actor: string | null) => Promise<boolean>;
  reportError: (error: unknown) => void;
};

// Only the user id: whether the session is still valid needs the database, and the proxy runs on
// every request. A stale id at worst routes a visitor to Rails, which re-checks it.
function sessionUserId(request: ProxyRequestInfo, deps: Deps): bigint | null {
  const secrets = deps.secrets();
  const name = deps.sessionCookieName();
  const session = readEncryptedCookie(secrets, name, request.cookies.get(name));
  const fromSession = wardenUserFromSession(session)?.userId ?? null;
  if (fromSession !== null) return fromSession;
  return parseRememberCookie(readSignedCookie(secrets, REMEMBER_COOKIE_NAME, request.cookies.get(REMEMBER_COOKIE_NAME)))?.userId ?? null;
}

export function createRailsRouteGate(deps: Deps): RouteGate {
  return {
    async isFlagEnabled(flag, request) {
      try {
        const userId = sessionUserId(request, deps);
        return await deps.isFeatureEnabled(flag, userId === null ? null : userActor(userId));
      } catch (error) {
        deps.reportError(error);
        return false;
      }
    },
    async signsInViaRememberCookie(request) {
      try {
        const name = deps.sessionCookieName();
        const session = readEncryptedCookie(deps.secrets(), name, request.cookies.get(name));
        if (wardenUserFromSession(session) !== null) return false;
        return parseRememberCookie(readSignedCookie(deps.secrets(), REMEMBER_COOKIE_NAME, request.cookies.get(REMEMBER_COOKIE_NAME))) !== null;
      } catch (error) {
        deps.reportError(error);
        // Rails can always serve it.
        return true;
      }
    },
    async isSignedIn(request) {
      try {
        return sessionUserId(request, deps) !== null;
      } catch (error) {
        deps.reportError(error);
        // "Signed in" keeps signed-out-only routes on Rails.
        return true;
      }
    },
  };
}

export const railsRouteGate = createRailsRouteGate({
  secrets: railsCookieSecrets,
  sessionCookieName: () => railsSessionCookieName(),
  isFeatureEnabled: (flag, actor) => flipperIsFeatureEnabled(flag, actor),
  reportError: (error) => console.error("[proxy-gate]", error),
});
