// CurrentSeller#switch_seller_account: stamps the membership and writes the permanent, encrypted current_seller_id cookie.
import type { TeamMembership } from "@prisma/client";

import { writeEncryptedCookie } from "../auth/rails-cookies.ts";
import { CURRENT_SELLER_COOKIE_NAME, railsCookieSecrets } from "../auth/rails-session-config.ts";
import { advance } from "../models/concerns/ruby-time.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { TeamMemberships } from "../models/team-membership.ts";

import { allDomain } from "./application-controller.ts";
import { setCookieHeader } from "./rack-cookies.ts";

// ActiveSupport's 20.years, for `cookies.permanent`.
const PERMANENT_COOKIE_YEARS = 20;

export async function switchSellerAccount(
  host: string,
  membership: ModelRecord<TeamMembership>,
  now: Date,
): Promise<string> {
  await TeamMemberships.updateBang(membership, { last_accessed_at: now }, { now: () => now });

  const expires = advance(now, { years: PERMANENT_COOKIE_YEARS });
  return setCookieHeader(CURRENT_SELLER_COOKIE_NAME, {
    value: writeEncryptedCookie(railsCookieSecrets(), CURRENT_SELLER_COOKIE_NAME, Number(membership.get("seller_id")), {
      expiresAt: expires,
    }),
    domain: allDomain(host),
    path: "/",
    expires,
    sameSite: "lax",
  });
}
