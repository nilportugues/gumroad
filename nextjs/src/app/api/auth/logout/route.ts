// Logout for both apps: what LoginsController#destroy does (stop impersonating, Devise sign_out with
// forget_me!, clear the dashboard preference), plus dropping the Auth.js session.
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { signOut } from "@/auth";
import { railsCookieSecrets, railsSessionCookieName } from "@/server/auth/rails-session-config";
import { railsSignOutCookies } from "@/server/auth/rails-session-writer";
import { isSameOriginRequest, safeRedirectPath } from "@/server/auth/redirects";
import { resolveAuth } from "@/server/auth/resolve";
import { prismaAuthStore } from "@/server/auth/store";

export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;
  if (!isSameOriginRequest(request, origin)) return new NextResponse(null, { status: 403 });

  const jar = await cookies();
  const now = new Date();
  const { context } = await resolveAuth({
    cookies: { get: (name) => jar.get(name)?.value },
    secrets: railsCookieSecrets(),
    sessionCookieName: railsSessionCookieName(),
    store: prismaAuthStore,
    now,
    skipSessionInvalidation: true,
  });
  // Rails' current_user, the admin while impersonating: their Redis key and their remember token.
  const user = context.loggedInUser;
  if (user) {
    await prismaAuthStore.clearImpersonation(user.id);
    await prismaAuthStore.forgetRememberedLogins(user.id, now);
  }

  await signOut({ redirect: false });
  for (const cookie of railsSignOutCookies(request.headers.get("host") ?? request.nextUrl.host)) {
    jar.set(cookie.name, cookie.value, cookie.options);
  }

  // after_sign_out_path_for: back to the referrer when it is on this host, else the homepage.
  return NextResponse.redirect(new URL(safeRedirectPath(request.headers.get("referer"), origin), origin), 303);
}
