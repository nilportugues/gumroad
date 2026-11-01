// Mints an Auth.js session from the visitor's own Rails session, then continues to callbackUrl.
// Safe as a GET: it can only ever sign the browser in as the user its Rails cookie already names.
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

import { RAILS_SESSION_PROVIDER, signIn } from "@/auth";
import { safeRedirectPath } from "@/server/auth/redirects";

export async function GET(request: NextRequest) {
  const callbackUrl = safeRedirectPath(request.nextUrl.searchParams.get("callbackUrl"), request.nextUrl.origin);
  try {
    // Redirects (by throwing) on success.
    await signIn(RAILS_SESSION_PROVIDER, { redirectTo: callbackUrl });
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
  }
  // No Rails session: log in on Rails, as authenticate_user! would send them.
  redirect(`/login?${new URLSearchParams({ next: callbackUrl })}`);
}
