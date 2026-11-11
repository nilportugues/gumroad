// Port of TeamInvitationThrottle (app/services/team_invitation_throttle.rb) and the send side of
// Settings::Team::InvitationsController: the Redis send throttle, the burst report and TeamMailer.invite.
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { notifyError } from "../infra/error-reporting.ts";
import { getRedis } from "../infra/redis.ts";
import { deliverLater, record } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { currentJobsRuntime, performAsync } from "./concerns/job-runtime.ts";
import { addDays, endOfDay, toCalendarDate } from "./concerns/ruby-time.ts";
import { column, selectRows, table } from "./sql.ts";
import { ACTIVE_INTERVAL_IN_DAYS } from "./team-invitation.ts";
import { isAccountActive, isCompliant, username, type UserRecord } from "./user.ts";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
// LIMITS: window name, sends allowed, window length.
const LIMITS = [
  ["hour", 10, SECONDS_PER_HOUR],
  ["day", 50, SECONDS_PER_DAY],
] as const;
// An unreviewed seller's total, revoked invitations included. The weekly risk scan reads the same number.
export const UNREVIEWED_TOTAL_LIMIT = 3;
const INVITATION_BURST_REPORT_TTL_SECONDS = SECONDS_PER_DAY;

// Checks both windows and reserves a send atomically; Redis supplies the clock. Kept character for character with the Ruby heredoc.
const CHECK_SCRIPT = `local time = redis.call("TIME")
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now - tonumber(ARGV[2]))
local restriction = {"", 0, 0}

for i = 3, #ARGV, 3 do
  local name, limit, period = ARGV[i], tonumber(ARGV[i + 1]), tonumber(ARGV[i + 2])
  local cutoff = "(" .. (now - period)
  local count = redis.call("ZCOUNT", KEYS[1], cutoff, "+inf")
  if count >= limit then
    local oldest = redis.call("ZRANGEBYSCORE", KEYS[1], cutoff, "+inf", "WITHSCORES", "LIMIT", count - limit, 1)
    local wait = math.ceil(tonumber(oldest[2]) + period - now)
    if wait > restriction[3] then restriction = {name, limit, wait} end
  end
end

if restriction[3] > 0 then return restriction end
redis.call("ZADD", KEYS[1], now, ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return {}
`;

export type SendRestriction = { window: string; limit: number; retry_after: number };

const sendThrottleKey = (sellerId: number | bigint) => `team_invitation_send_throttle:${sellerId}`;
const burstReportedKey = (sellerId: number | bigint) => `team_invitation_burst_reported:${sellerId}`;

// `TeamInvitationThrottle.check(seller_id)`
export async function checkSendThrottle(
  sellerId: number | bigint,
  redis: Redis = getRedis("main"),
): Promise<SendRestriction | null> {
  const longestWindow = Math.max(...LIMITS.map(([, , period]) => period));
  const result = (await redis.eval(
    CHECK_SCRIPT,
    1,
    sendThrottleKey(sellerId),
    randomUUID(),
    String(longestWindow),
    ...LIMITS.flatMap(([name, limit, period]) => [name, String(limit), String(period)]),
  )) as [string, number, number] | [];
  const [window, limit, retryAfter] = result;
  return window === undefined ? null : { window, limit: Number(limit), retry_after: Number(retryAfter) };
}

// `unreviewed_limit_reached?`: only a reviewed, active seller is trusted with the per-window allowance.
export async function unreviewedLimitReached(seller: UserRecord): Promise<boolean> {
  if (isCompliant(seller) && isAccountActive(seller)) return false;
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("team_invitations")} WHERE ${column("team_invitations", "seller_id")} = ${seller.get("id")}`,
  );
  return Number(row!.count) >= UNREVIEWED_TOTAL_LIMIT;
}

// `invitation_limit_message`
export function invitationLimitMessage(name: string, limit: number, retryAfter: number): string {
  if (retryAfter <= 0) return "You can invite again now.";
  const [unit, seconds] =
    name === "day" ? (["hour", SECONDS_PER_HOUR] as const) : (["minute", SECONDS_PER_MINUTE] as const);
  const remaining = Math.max(Math.ceil(retryAfter / seconds), 1);
  return `You've reached the limit of ${limit} team invitations per ${name}. You can invite again in ${remaining} ${remaining === 1 ? unit : `${unit}s`}.`;
}

// `report_invitation_burst`: once per seller per day. A notification failure must preserve the refusal.
export async function reportInvitationBurst(
  seller: UserRecord,
  restriction: { window: string; limit: number },
  redis: Redis = getRedis("main"),
): Promise<void> {
  try {
    const first = await redis.set(
      burstReportedKey(seller.get("id")),
      "1",
      "EX",
      INVITATION_BURST_REPORT_TTL_SECONDS,
      "NX",
    );
    if (first === null) return;
    await performAsync("InternalNotificationWorker", [
      "risk",
      "Team invitations rate limited",
      `Seller ${username(seller)} (${seller.get("email") ?? ""}) was refused team invitations past ${restriction.limit}/${restriction.window}. Admin: ${seller.get("external_id")}`,
    ]);
  } catch (error) {
    notifyError(error);
  }
}

// `ACTIVE_INTERVAL_IN_DAYS.days.from_now.at_end_of_day`, which a datetime(6) column keeps as .999999.
export const invitationExpiry = (now: Date = new Date()) =>
  endOfDay(addDays(toCalendarDate(now), ACTIVE_INTERVAL_IN_DAYS));

// `TeamMailer.invite(team_invitation).deliver_later`
export async function deliverInvite(invitationId: number | bigint): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    { mailer: "TeamMailer", method: "invite", args: [record("TeamInvitation", invitationId)] },
    mailRoute("TeamMailer", "invite"),
  );
}
