// Port of app/controllers/healthcheck_controller.rb. Each action is a function of its dependencies so
// tests can stand in for what the Rails spec stubs (Sidekiq queue sizes, the Stripe registration).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { type RailsCache, railsCache } from "../cache/rails-cache.ts";
import { getRedis } from "../infra/redis.ts";
import { rubyToI } from "../mail/mailer-info.ts";
import { selectRows } from "../models/sql.ts";
import { StripeError } from "../stripe/errors.ts";
import * as StagingApplePayDomainRegistration from "../services/staging-apple-pay-domain-registration.ts";
import { type ActionOptions, processAction, type Rendered, RoutingError } from "./application-controller.ts";
import { isPresent } from "./rails-request.ts";

const SIDEKIQ_QUEUE_LIMITS: [string, number][] = [
  ["critical", 12_000],
  ["default", 300_000],
];
const SIDEKIQ_RETRIES_LIMIT = 20_000;

const HOUR_MS = 3_600_000;
// AlertOnStalledAbandonedCartEmailsJob::STALL_THRESHOLD + 2.hours
const ABANDONED_CART_EMAIL_STALE_AFTER_MS = 24 * HOUR_MS + 2 * HOUR_MS;
// PayoutBatchInFlightTracking::IN_FLIGHT_ENTRY_TTL and LongRunningJobTracking::IN_FLIGHT_ENTRY_TTL
const PAYOUT_BATCH_IN_FLIGHT_ENTRY_TTL_MS = 3 * HOUR_MS;
const LONG_RUNNING_JOB_IN_FLIGHT_ENTRY_TTL_MS = 6 * HOUR_MS;
const PURCHASES_WINDOW_MS = 10 * 60_000;
const PURCHASES_COUNT_CACHE_SECONDS = 30;

// RedisKey
export const REDIS_KEYS = {
  payoutBatchInFlight: "payouts:batch_in_flight",
  longRunningJobsInFlight: "deploy:long_running_jobs_in_flight",
  paypalTopupNeeded: "paypal:topup_needed",
  stripeBalanceTopupNeeded: "stripe:balance_topup_needed",
  minSuccessfulPurchasesInLast10Minutes: "healthcheck:min_successful_purchases_in_last_10_minutes",
} as const;

export type HealthcheckDeps = {
  redis: () => Redis;
  // Sidekiq::Queue.new(name).size and Sidekiq::RetrySet.new.size
  sidekiqQueueSize: (name: string) => Promise<number>;
  sidekiqRetrySetSize: () => Promise<number>;
  cache: () => RailsCache;
  now: () => Date;
  applePayApplicable: () => boolean;
  registerApplePayDomain: () => Promise<StagingApplePayDomainRegistration.ApplePayRegistrationResult>;
};

export const defaultHealthcheckDeps: HealthcheckDeps = {
  redis: () => getRedis("main"),
  sidekiqQueueSize: (name) => getRedis("sidekiq").llen(`queue:${name}`),
  sidekiqRetrySetSize: () => getRedis("sidekiq").zcard("retry"),
  cache: railsCache,
  now: () => new Date(),
  applePayApplicable: StagingApplePayDomainRegistration.applicable,
  registerApplePayDomain: () => StagingApplePayDomainRegistration.register(),
};

const plain = (body: string, status: number): Rendered => ({ status, body, contentType: "text/plain; charset=utf-8" });
const statusName = (ok: boolean) => (ok ? "ok" : "service_unavailable");
const httpStatus = (ok: boolean) => (ok ? 200 : 503);

// DeployBlockingJobTracking.any_in_flight?: prunes entries older than the TTL, then counts.
export async function anyInFlight(redis: Redis, key: string, entryTtlMs: number, now: Date): Promise<boolean> {
  const oldestValidScore = Math.floor((now.getTime() - entryTtlMs) / 1000);
  await redis.zremrangebyscore(key, "-inf", `(${oldestValidScore}`);
  return (await redis.zcard(key)) > 0;
}

// Rails' quoted datetime: UTC, microseconds.
function sqlTime(time: Date): string {
  return `${time.toISOString().replace("T", " ").replace("Z", "")}000`;
}

export const actions = {
  async index(): Promise<Rendered> {
    return plain("healthcheck", 200);
  },

  async sidekiq(deps: HealthcheckDeps): Promise<Rendered> {
    let aboveLimit = false;
    for (const [queue, limit] of SIDEKIQ_QUEUE_LIMITS) {
      if ((await deps.sidekiqQueueSize(queue)) > limit) {
        aboveLimit = true;
        break;
      }
    }
    if (!aboveLimit) aboveLimit = (await deps.sidekiqRetrySetSize()) > SIDEKIQ_RETRIES_LIMIT;
    return plain(`Sidekiq: ${statusName(!aboveLimit)}`, httpStatus(!aboveLimit));
  },

  async payouts(deps: HealthcheckDeps): Promise<Rendered> {
    const inFlight = await anyInFlight(deps.redis(), REDIS_KEYS.payoutBatchInFlight, PAYOUT_BATCH_IN_FLIGHT_ENTRY_TTL_MS, deps.now());
    return plain(`Payouts: ${inFlight ? "batch in flight" : "no batch in flight"}`, httpStatus(!inFlight));
  },

  async long_running_jobs(deps: HealthcheckDeps): Promise<Rendered> {
    const inFlight = await anyInFlight(deps.redis(), REDIS_KEYS.longRunningJobsInFlight, LONG_RUNNING_JOB_IN_FLIGHT_ENTRY_TTL_MS, deps.now());
    return plain(`Long running jobs: ${inFlight ? "job in flight" : "no job in flight"}`, httpStatus(!inFlight));
  },

  async paypal_balance(deps: HealthcheckDeps): Promise<Rendered> {
    const notNeeded = (await deps.redis().get(REDIS_KEYS.paypalTopupNeeded)) === "false";
    return plain(`PayPal balance: ${notNeeded ? "topup not required" : "topup required"}`, httpStatus(notNeeded));
  },

  async stripe_balance(deps: HealthcheckDeps): Promise<Rendered> {
    const notNeeded = (await deps.redis().get(REDIS_KEYS.stripeBalanceTopupNeeded)) === "false";
    return plain(`Stripe balance: ${notNeeded ? "topup not required" : "topup required"}`, httpStatus(notNeeded));
  },

  async apple_pay_domain(deps: HealthcheckDeps): Promise<Rendered> {
    if (!deps.applePayApplicable()) throw new RoutingError("Not Found");
    try {
      const result = await deps.registerApplePayDomain();
      return plain(result.message, httpStatus(result.active));
    } catch (error) {
      if (error instanceof StripeError) return plain(`Apple Pay domain registration failed: ${error.message}`, 503);
      throw error;
    }
  },

  async purchases(deps: HealthcheckDeps): Promise<Rendered> {
    const threshold = await deps.redis().get(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes);
    const count = await deps.cache().fetch("healthcheck:purchases:successful_last_10_minutes", { expiresIn: PURCHASES_COUNT_CACHE_SECONDS }, async () => {
      const now = deps.now();
      const [row] = await selectRows<{ count: bigint }>(
        Prisma.sql`SELECT COUNT(*) AS count FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'successful' AND \`purchases\`.\`created_at\` BETWEEN ${sqlTime(new Date(now.getTime() - PURCHASES_WINDOW_MS))} AND ${sqlTime(now)}`,
      );
      return Number(row?.count ?? 0);
    });
    const healthy = isPresent(threshold) && Number(count) >= rubyToI(threshold);
    return plain(`Purchases: ${statusName(healthy)}`, httpStatus(healthy));
  },

  async abandoned_cart_emails(deps: HealthcheckDeps): Promise<Rendered> {
    const [row] = await selectRows<{ created_at: Date }>(
      Prisma.sql`SELECT \`sent_abandoned_cart_emails\`.\`created_at\` FROM \`sent_abandoned_cart_emails\` ORDER BY \`sent_abandoned_cart_emails\`.\`id\` DESC LIMIT 1`,
    );
    const lastSentAt = row?.created_at ?? null;
    const healthy = lastSentAt !== null && lastSentAt.getTime() > deps.now().getTime() - ABANDONED_CART_EMAIL_STALE_AFTER_MS;
    return plain(`Abandoned cart emails: ${statusName(healthy)}`, httpStatus(healthy));
  },
} satisfies Record<string, (deps: HealthcheckDeps) => Promise<Rendered>>;

export type HealthcheckAction = keyof typeof actions;

// `skip_before_action :redirect_to_custom_subdomain, only: :index`; set_is_user_custom_domain, also
// skipped for index, never reaches the response.
const OPTIONS: Partial<Record<HealthcheckAction, ActionOptions>> = { index: { skip: ["redirect_to_custom_subdomain"] } };

let deps: HealthcheckDeps = defaultHealthcheckDeps;

export function setHealthcheckDepsForTesting(next: Partial<HealthcheckDeps> | null): void {
  deps = next === null ? defaultHealthcheckDeps : { ...defaultHealthcheckDeps, ...next };
}

// GET and HEAD handlers for one action's route module.
export function healthcheckRoute(name: HealthcheckAction) {
  const handler = (request: Request) => processAction(request, OPTIONS[name] ?? {}, () => actions[name](deps));
  return { GET: handler, HEAD: handler };
}
