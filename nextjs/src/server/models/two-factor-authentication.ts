// Port of TwoFactorAuthentication#send_authentication_token! (app/models/concerns/two_factor_authentication.rb)
// and EmailRouterFallbackService.email_provider_for_two_factor: the enqueue side of
// TwoFactorAuthenticationMailer#authentication_token. No Node code sends the token yet; the first
// login flow to move over calls this.
import { isFeatureEnabled } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";
import { deliverLater, keywordArgs } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { EMAIL_PROVIDER_RESEND, forceSendgridForRecipients } from "../mail/mailer-info.ts";
import type { JobsRuntime } from "../jobs/runtime.ts";

const MAILER = "TwoFactorAuthenticationMailer";
const METHOD = "authentication_token";
const FALLBACK_FEATURE = "resend_fallback_for_auth_emails";

export type TwoFactorDeps = {
  featureActive: (name: string) => Promise<boolean>;
  // $redis.exists?
  redisExists: (key: string) => Promise<boolean>;
};

const defaultDeps: TwoFactorDeps = {
  featureActive: (name) => isFeatureEnabled(name),
  redisExists: async (key) => (await getRedis("main").exists(key)) > 0,
};

// `email_provider_for_two_factor`: the other provider, but only while a first email may still be
// in flight, and never Resend for recipients it cannot reach.
export async function emailProviderForTwoFactor(user: { id: number | bigint; email: string | null }, deps: TwoFactorDeps = defaultDeps): Promise<string | null> {
  if (!(await deps.featureActive(FALLBACK_FEATURE))) return null;
  if (!(await deps.redisExists(`email_router_fallback:${String(user.id)}`))) return null;
  if (forceSendgridForRecipients(user.email)) return null;
  return EMAIL_PROVIDER_RESEND;
}

// `TwoFactorAuthenticationMailer.authentication_token(id, email_provider:).deliver_later(queue: "critical")`
export async function sendAuthenticationToken(
  runtime: JobsRuntime,
  user: { id: number | bigint; email: string | null },
  deps: TwoFactorDeps = defaultDeps,
): Promise<void> {
  const emailProvider = await emailProviderForTwoFactor(user, deps);
  await deliverLater(runtime, { mailer: MAILER, method: METHOD, args: [Number(user.id), keywordArgs({ email_provider: emailProvider })], queue: "critical" }, mailRoute(MAILER, METHOD));
}
