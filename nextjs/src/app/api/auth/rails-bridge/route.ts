// Mints an Auth.js session from the visitor's own Rails session, then continues to callbackUrl.
// Safe as a GET: it can only ever sign the browser in as the user its Rails cookie already names.
import { type NextRequest } from "next/server";

import { RAILS_SESSION_PROVIDER, signIn } from "@/auth";
import { safeRedirectPath } from "@/server/auth/redirects";

export async function GET(request: NextRequest) {
  const callbackUrl = safeRedirectPath(request.nextUrl.searchParams.get("callbackUrl"), request.nextUrl.origin);
  // On failure Auth.js redirects to pages.signIn, which is Rails' /login.
  await signIn(RAILS_SESSION_PROVIDER, { redirectTo: callbackUrl });
}
