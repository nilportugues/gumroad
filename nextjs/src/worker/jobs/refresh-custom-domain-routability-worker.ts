// Port of the guards of app/sidekiq/refresh_custom_domain_routability_worker.rb: a deleted, unverified or certificate-less domain, and
// one checked within the last 6 hours, is left alone. A domain that is due goes to CustomDomainRoutabilityService (DNS and TLS lookups
// of the seller's domain, plus the writes of its result), which stays with Rails: the job is handed back right after the read.
// Golden: __fixtures__/refresh-custom-domain-routability-worker.golden.json
// (scripts/golden/refresh-custom-domain-routability-worker.rb); the service was replaced by a recorder there.
import { Prisma, type CustomDomain } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const CUSTOM_DOMAINS = "custom_domains";
// CustomDomain::CERTIFICATE_LIFETIME and ROUTABILITY_REFRESH_INTERVAL
const CERTIFICATE_LIFETIME = { days: 90 };
const ROUTABILITY_REFRESH_INTERVAL = { hours: 6 };

export const refreshCustomDomainRoutabilityWorkerWith = modelJob({ min: 1 }, async ([customDomainId], deps) => {
  const key =
    customDomainId === null
      ? null
      : await beforeSideEffects(() => recordIdFrom(customDomainId, "CustomDomain.find_by"));
  // `CustomDomain.alive.find_by(id:)`
  const idCondition =
    key === null
      ? Prisma.sql`${column(CUSTOM_DOMAINS, "id")} IS NULL`
      : Prisma.sql`${column(CUSTOM_DOMAINS, "id")} = ${key}`;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(CUSTOM_DOMAINS)}.*`)} FROM ${table(CUSTOM_DOMAINS)} WHERE ${column(CUSTOM_DOMAINS, "deleted_at")} IS NULL AND ${idCondition} LIMIT 1`,
  );
  if (row === undefined) return;
  const domain = castRow<CustomDomain>("CustomDomain", row);

  // CustomDomain#active?: verified and holding a certificate younger than its lifetime
  const issuedAt = domain.ssl_certificate_issued_at;
  if (domain.state !== "verified" || issuedAt === null || !(issuedAt > ago(CERTIFICATE_LIFETIME, deps.now()))) return;
  // CustomDomain#routability_refresh_due?
  const checkedAt = domain.routability_checked_at;
  if (checkedAt !== null && !(checkedAt < ago(ROUTABILITY_REFRESH_INTERVAL, deps.now()))) return;

  throw new HandBackToRuby("CustomDomainRoutabilityService is not ported");
});

export const refreshCustomDomainRoutabilityWorker = refreshCustomDomainRoutabilityWorkerWith();
