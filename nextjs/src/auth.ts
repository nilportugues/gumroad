// Auth.js over the existing users table. The Rails session cookie stays authoritative while login
// lives in Rails: an Auth.js session is minted from it (the "rails-session" provider) and dropped as
// soon as it no longer matches it, so a Rails logout is a Next logout too.
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Apple from "next-auth/providers/apple";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Twitter from "next-auth/providers/twitter";
import { cookies, headers } from "next/headers";

import { cookiesFromHeader } from "./server/auth/cookie-header";
import { authorizePassword, LoginError } from "./server/auth/credentials";
import { railsCookieSecrets, railsSessionCookieName } from "./server/auth/rails-session-config";
import { railsSignInCookie } from "./server/auth/rails-session-writer";
import { resolveAuth, type CookieSource } from "./server/auth/resolve";
import { prismaAuthStore } from "./server/auth/store";
import { getConfig } from "./server/infra/config";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // matches the Rails session's expire_after
export const RAILS_SESSION_PROVIDER = "rails-session";
export const PASSWORD_PROVIDER = "credentials";

class PasswordLoginError extends CredentialsSignin {
  constructor(code: string) {
    super();
    this.code = code;
  }
}

// The Warden user (Rails' current_user) the Rails cookies sign in, if any.
async function railsUserId(source: CookieSource): Promise<string | null> {
  const { context } = await resolveAuth({ cookies: source, secrets: railsCookieSecrets(), sessionCookieName: railsSessionCookieName(), store: prismaAuthStore });
  return context.loggedInUser ? String(context.loggedInUser.id) : null;
}

const toAuthUser = (user: { id: bigint; email: string | null; name: string | null }) => ({ id: String(user.id), email: user.email, name: user.name });

function providers(): NextAuthConfig["providers"] {
  const list: NextAuthConfig["providers"] = [
    Credentials({
      id: RAILS_SESSION_PROVIDER,
      name: "Gumroad session",
      credentials: {},
      async authorize(_credentials, request) {
        const { context } = await resolveAuth({
          cookies: cookiesFromHeader(request.headers.get("cookie")),
          secrets: railsCookieSecrets(),
          sessionCookieName: railsSessionCookieName(),
          store: prismaAuthStore,
        });
        return context.loggedInUser ? toAuthUser(context.loggedInUser) : null;
      },
    }),
  ];

  // Off until WS-10 ports rack-attack's login throttling, trackable, remember-me and 2FA: until
  // then, a password endpoint here would be an unthrottled side door to Rails' login.
  if (getConfig("AUTH_PASSWORD_LOGIN") === "enabled") {
    list.push(
      Credentials({
        id: PASSWORD_PROVIDER,
        credentials: { login_identifier: {}, password: {} },
        async authorize(credentials) {
          try {
            return toAuthUser(await authorizePassword(credentials, prismaAuthStore));
          } catch (error) {
            if (error instanceof LoginError) throw new PasswordLoginError(error.code);
            throw error;
          }
        },
      }),
    );
  }

  // Configured so the callback URLs can be registered; sign-in through them is refused in
  // callbacks.signIn until WS-10 ports User.find_or_create_for_*.
  const google = { id: getConfig("GOOGLE_CLIENT_ID"), secret: getConfig("GOOGLE_CLIENT_SECRET") };
  if (google.id && google.secret) list.push(Google({ clientId: google.id, clientSecret: google.secret }));
  const twitter = { id: getConfig("TWITTER_APP_ID"), secret: getConfig("TWITTER_APP_SECRET") };
  if (twitter.id && twitter.secret) list.push(Twitter({ clientId: twitter.id, clientSecret: twitter.secret }));
  const apple = { id: getConfig("APPLE_CLIENT_ID"), secret: getConfig("APPLE_CLIENT_SECRET") };
  if (apple.id && apple.secret) list.push(Apple({ clientId: apple.id, clientSecret: apple.secret }));
  const stripe = { id: getConfig("STRIPE_CONNECT_CLIENT_ID"), secret: getConfig("STRIPE_SECRET") };
  if (stripe.id && stripe.secret) {
    list.push({
      id: "stripe_connect",
      name: "Stripe",
      type: "oauth",
      authorization: { url: "https://connect.stripe.com/oauth/authorize", params: { scope: "read_write", response_type: "code" } },
      token: "https://connect.stripe.com/oauth/token",
      userinfo: { url: "https://api.stripe.com/v1/account" },
      clientId: stripe.id,
      clientSecret: stripe.secret,
      profile: (profile: { id: string; email?: string }) => ({ id: profile.id, email: profile.email ?? null }),
    });
  }
  return list;
}

export const authConfig: NextAuthConfig = {
  providers: providers(),
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  callbacks: {
    signIn({ account }) {
      return account?.type === "credentials";
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.sub = user.id;
        token.provider = account?.provider;
        return token;
      }
      // Every later read re-checks Rails, so its logout, a password change or a session
      // invalidation ends this session too. Returning null clears the Auth.js cookie.
      const jar = await cookies();
      return (await railsUserId({ get: (name) => jar.get(name)?.value })) === token.sub ? token : null;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    // A password login here has to be one in Rails too, or the jwt check above would drop it.
    async signIn({ user, account }) {
      if (account?.provider !== PASSWORD_PROVIDER || !user.id) return;
      const found = await prismaAuthStore.findUserById(BigInt(user.id));
      if (!found) return;
      const requestHeaders = await headers();
      const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
      const cookie = railsSignInCookie(found, host);
      (await cookies()).set(cookie.name, cookie.value, cookie.options);
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
