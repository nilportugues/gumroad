// Ports of the jobs that need only Stripe and simple models:
// app/sidekiq/sync_stripe_business_profile_url_job.rb,
// app/sidekiq/create_stripe_apple_pay_domain_worker.rb and
// app/sidekiq/delete_stripe_apple_pay_domain_worker.rb.
import { Prisma, type User } from "@prisma/client";

import { domainConfig } from "../../server/infra/domain.ts";
import { notifyError } from "../../server/infra/error-reporting.ts";
import { railsEnv } from "../../server/infra/rails-env.ts";
import { isInvalidUriError, rubyUriParse } from "../../server/models/concerns/ruby-uri.ts";
import { stripeAccountOf } from "../../server/models/merchant-account.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, isRecordNotUnique, selectRows, table } from "../../server/models/sql.ts";
import { lockByDomain, StripeApplePayDomains } from "../../server/models/stripe-apple-pay-domain.ts";
import { DENYLIST, isDeleted, rubyStrip, subdomain, subdomainFromUsername, subdomainWithProtocol, username, Users, type UserRecord } from "../../server/models/user.ts";
import { InvalidRequestError, PermissionError } from "../../server/stripe/errors.ts";
import { Account, ApplePayDomain } from "../../server/stripe/resources.ts";
import type { RetriesExhausted } from "../retry.ts";
import { modelJob } from "./support/job-deps.ts";

async function findUser(userId: unknown): Promise<UserRecord | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
  return row ? Users.load(castRow<User>("User", row)) : null;
}

class RecordNotFound extends Error {
  readonly rubyClass = "ActiveRecord::RecordNotFound";
}

// `record.user_id == user_id`: Integer#== against the job argument, which is false for a String.
const sameId = (column: bigint, arg: unknown) => (typeof arg === "number" || typeof arg === "bigint") && BigInt(arg) === column;

// Assigning the argument to an integer column. Payloads carry the id as a JSON integer.
function integerId(arg: unknown): bigint {
  if (typeof arg === "bigint") return arg;
  if (typeof arg === "number" && Number.isInteger(arg)) return BigInt(arg);
  if (typeof arg === "string" && /^\d+$/u.test(arg)) return BigInt(arg);
  throw new TypeError(`user_id ${String(arg)} is not an integer id`);
}

// `rescue A, B => e` matches subclasses, as instanceof does.
const rubyClassOf = (error: Error) => (error as { rubyClass?: string }).rubyClass ?? error.name;

// business_profile_host: nil for a blank or unparseable URL.
function businessProfileHost(account: { business_profile?: { url?: unknown } | null }): string | null {
  const raw = account.business_profile?.url;
  let url = rubyStrip(raw == null ? "" : String(raw));
  if (isBlank(url)) return null;
  if (!url.includes("://")) url = `https://${url}`;
  try {
    return rubyUriParse(url).host?.toLowerCase() ?? null;
  } catch (error) {
    if (isInvalidUriError(error)) return null;
    throw error;
  }
}

// `URI(string).host.downcase`, which raises outside business_profile_host's rescue.
const uriHost = (url: string) => rubyUriParse(url).host!.toLowerCase();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\-]/gu, "\\$&");

function isStaleSellerSubdomain(host: string | null, user: UserRecord): boolean {
  if (isBlank(host)) return false;
  const { protocol, rootDomain } = domainConfig();
  const rootHost = uriHost(`${protocol}://${rootDomain}`);
  // Subdomain::USERNAME_REGEXP between \A and \z.
  if (!new RegExp(`^[a-z0-9-]+\\.${escapeRegExp(rootHost)}$`, "u").test(host!)) return false;
  if (DENYLIST.includes(host!.split(".")[0]!)) return false;
  return host !== uriHost(subdomainWithProtocol(user)!);
}

export const syncStripeBusinessProfileUrlJobWith = modelJob({ min: 1 }, async ([userId]) => {
  try {
    const user = await findUser(userId);
    const merchantAccount = user ? await stripeAccountOf(user.get("id")) : null;
    if (!user || isDeleted(user) || isBlank(subdomain(user)) || !merchantAccount) return;

    const stripeAccountId = merchantAccount.charge_processor_merchant_id as string | null;
    const stripeHost = businessProfileHost(await Account.retrieve(stripeAccountId));
    if (!isStaleSellerSubdomain(stripeHost, user)) return;

    // User#business_profile_url
    await Account.update(stripeAccountId, { business_profile: { url: subdomainWithProtocol(user) } });
  } catch (error) {
    if (!(error instanceof InvalidRequestError || error instanceof PermissionError)) throw error;
    console.info(`SyncStripeBusinessProfileUrlJob: skipped user ${String(userId)}: ${rubyClassOf(error)}: ${error.message}`);
  }
});

async function registrationMissingOnStripe(stripeId: string): Promise<boolean> {
  try {
    await ApplePayDomain.retrieve(stripeId);
    return false;
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    if (error.code !== "resource_missing") throw error;
    return true;
  }
}

// The row lock serializes with a delete queued or running for the username's previous holder.
// Commits before returning false: two creates holding an empty lookup's gap lock across the
// Stripe call would deadlock on their inserts.
async function claimExistingRegistration(userId: unknown, domain: string, now: () => Date): Promise<boolean> {
  return transaction(async () => {
    const existing = await lockByDomain(domain);
    if (!existing) return false;
    if (sameId(existing.get("user_id"), userId)) return true;

    // The previous holder's delete can reach Stripe and still fail with every response lost.
    if (await registrationMissingOnStripe(existing.get("stripe_id"))) {
      await StripeApplePayDomains.destroyBang(existing);
      return false;
    }
    await StripeApplePayDomains.updateBang(existing, { user_id: integerId(userId) }, { now });
    return true;
  });
}

export const createStripeApplePayDomainWorkerWith = modelJob({ min: 1, max: 2 }, async ([userId, domainArg], deps) => {
  if (railsEnv() === "test") return;

  let domain = domainArg == null || domainArg === false ? null : (domainArg as string);
  try {
    const user = await findUser(userId);
    if (!user) throw new RecordNotFound(`Couldn't find User with 'id'=${String(userId)}`);
    domain ??= subdomainFromUsername(username(user));
    if (isBlank(domain)) return;

    if (await claimExistingRegistration(userId, domain!, deps.now)) return;

    const response = await ApplePayDomain.create({ domain_name: domain });
    if (!response) return;

    await StripeApplePayDomains.create({ user_id: integerId(userId), domain: domain!, stripe_id: response.id }, { now: deps.now });
  } catch (error) {
    // A concurrent create inserted first. Claim its row, or retry if it is gone here or on Stripe.
    if (!isRecordNotUnique(error)) throw error;
    if (!(await claimExistingRegistration(userId, domain!, deps.now))) throw error;
  }
});

// Holds the row lock through the Stripe call so a create taking the host over waits for it.
// Looked up by domain alone: that create may already have handed the row to the new holder.
export const deleteStripeApplePayDomainWorkerWith = modelJob({ min: 2 }, async ([userId, domain]) => {
  await transaction(async () => {
    const record = await lockByDomain(domain as string);
    if (!record || !sameId(record.get("user_id"), userId)) return;
    try {
      const response = await ApplePayDomain.delete(record.get("stripe_id"));
      if (response.deleted) await StripeApplePayDomains.destroy(record);
    } catch (error) {
      if (!(error instanceof InvalidRequestError)) throw error;
      await StripeApplePayDomains.destroy(record);
    }
  });
});

// sentry-sidekiq is not in the bundle, so without this an exhausted job only reaches the log and
// the dead set.
export const createStripeApplePayDomainWorkerRetriesExhausted: RetriesExhausted = async (msg) => {
  const [userId, domain] = msg.args as unknown[];
  notifyError(
    `CreateStripeApplePayDomainWorker exhausted Sidekiq retries for user ${userId == null ? "" : String(userId)} ` +
      `(domain ${domain == null || domain === false ? "unknown" : String(domain)}). Inspect the dead job for the error and the registration ` +
      "state before retrying.",
  );
};

export const syncStripeBusinessProfileUrlJob = syncStripeBusinessProfileUrlJobWith();
export const createStripeApplePayDomainWorker = createStripeApplePayDomainWorkerWith();
export const deleteStripeApplePayDomainWorker = deleteStripeApplePayDomainWorkerWith();
