// Sellers::SwitchController#create: the account switcher of the dashboard.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { writeEncryptedCookie } from "../auth/rails-cookies.ts";
import { CURRENT_SELLER_COOKIE_NAME, railsCookieSecrets } from "../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { advance } from "../models/concerns/ruby-time.ts";
import { TeamMemberships } from "../models/team-membership.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import type { TeamMembership } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { allDomain, HandBackToRails } from "./application-controller.ts";
import { registerMutations } from "./mutation.ts";
import { setCookieHeader } from "./rack-cookies.ts";

// ActiveSupport's 20.years, for `cookies.permanent`.
const PERMANENT_COOKIE_YEARS = 20;

registerMutations({
  method: "POST",
  pattern: "/sellers/switch",
  async run({ request, context, params }) {
    const user = railsLoggedInUser(context);
    if (!user) throw new HandBackToRails("a visitor who is not signed in");
    // RequireAccountEmail answers a user without an email by format.
    if (!user.email && !user.unconfirmed_email && !context.impersonatedUser) throw new HandBackToRails("a user without an email");
    // params.require(:team_membership_id) raises ParameterMissing (a 400) for a missing or blank value.
    const externalId = params.team_membership_id;
    if (typeof externalId !== "string" || externalId.trim() === "") throw new HandBackToRails("a missing team_membership_id");

    // logged_in_user.user_memberships.switchable.find_by_external_id!: a miss is rescued into the same 204.
    const id = decrypt(externalId);
    const membership = id === null ? undefined : (await prismaAuthStore.switchableMemberships(user.id)).find((candidate) => Number(candidate.id) === id);
    if (membership === undefined) return { status: 204, body: "", contentType: "" };

    const now = new Date();
    const [row] = await selectRows<TeamMembership>(Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.*")} FROM ${table("team_memberships")} WHERE ${column("team_memberships", "id")} = ${membership.id} LIMIT 1`);
    await TeamMemberships.updateBang(TeamMemberships.load(castRow<TeamMembership>("TeamMembership", row!)), { last_accessed_at: now }, { now: () => now });

    const expires = advance(now, { years: PERMANENT_COOKIE_YEARS });
    const cookie = setCookieHeader(CURRENT_SELLER_COOKIE_NAME, {
      value: writeEncryptedCookie(railsCookieSecrets(), CURRENT_SELLER_COOKIE_NAME, Number(membership.seller_id), { expiresAt: expires }),
      domain: allDomain(request.host),
      path: "/",
      expires,
      sameSite: "lax",
    });
    return { status: 204, body: "", contentType: "", cookies: [cookie] };
  },
});
