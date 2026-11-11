// Api::Internal::Admin::PiracyReportsController#create, #start_screening, #screen, #counter_notice and #resolve. What the port cannot
// reproduce goes to Rails whole (a NotPortedError before the first write): a pass verdict (renders the notice and mails the seller),
// a counter-notice or an outcome that is accepted (they mail the seller) and a URL Ruby's URI parser could read differently.
import { createHash, randomInt } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { NotPortedError } from "../../models/user.ts";
import { domainConfig } from "../../page-props/domain.ts";
import { eligibilityErrors } from "../../page-props/piracy-reports/pages.ts";
import { type AdminRequest, failure, halted, isBlank, jsonRendered, paramToS, PIRACY_SCOPE, recordAdminWrite } from "./base.ts";
import { type DetailReport, REPORT_NOT_FOUND, serializeDetail } from "./piracy-report-detail.ts";
import { SOURCE, serializeSummary } from "./piracy-reports.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite, toSentence } from "./user-writes.ts";

const WRAPPER = { key: "piracy_report", model: "PiracyReport" };
const MONTHLY_LIMIT = 5;
const MAX_REPORTED_URL_LENGTH = 500;
const MAX_TICKET_URL_LENGTH = 1024;
const MAX_REASON_LENGTH = 280;
const MAX_COUNTER_NOTICE_LENGTH = 20_000;
const MAX_COUNTER_NOTICE_BYTES = 65_535;
const MAX_OUTCOME_REASON_LENGTH = 2000;
const SCREENING_VERDICTS = ["pass", "fail", "review"];
const SCREENING_CHECKS = ["page_offers_work", "not_other_authorized_use", "not_licensee_or_related_party"];
const OUTCOMES = ["removed", "no_response", "restored", "withdrawn"];
const REOPENABLE_OUTCOMES = ["removed", "no_response"];
const HOSTED_ON_GUMROAD_ERROR = "Pages hosted on Gumroad are reported through the terms of service process";
const EXTERNAL_ID_LENGTH = 21;
const EXTERNAL_ID_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MS_PER_DAY = 86_400_000;
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };
// A host, port, path, query and fragment URI.parse accepts without a second reading (no userinfo, IPv6, brackets or bare percent signs).
const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const HTTP_URL = new RegExp(`^(https?)://([A-Za-z0-9](?:[A-Za-z0-9.-]*))(?::(\\d{1,5}))?((?:/${PCHAR}*)*)(?:\\?((?:${PCHAR}|[/?])*))?(?:#(?:${PCHAR}|[/?])*)?$`, "iu");

type Tx = Prisma.TransactionClient;
type Parsed = { scheme: string; host: string; port: number; path: string; query: string | null };

// String#strip: whitespace and NUL at both ends.
const rubyStrip = (value: string): string => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");
const charLength = (value: string): number => [...value].length;
const isHash = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unprocessable = (errors: string[]) => jsonRendered({ success: false, message: toSentence(errors), errors }, 422);
const auditTarget = (report: { id: bigint; external_id: string }) => ({ type: "PiracyReport", id: report.id, externalId: report.external_id });

async function findReport(admin: AdminRequest): Promise<DetailReport | null> {
  return db.piracyReport.findFirst({ where: { external_id: paramToS(admin.params.id, SOURCE) }, include: { seller: true, product: true } });
}

// with_lock: the row is locked and reloaded, so a concurrent second request sees the first one's result.
async function withLock<T>(report: DetailReport, block: (tx: Tx, locked: DetailReport) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM piracy_reports WHERE id = ${report.id} FOR UPDATE`;
    const locked = await tx.piracyReport.findUniqueOrThrow({ where: { id: report.id }, include: { seller: true, product: true } });
    return block(tx, locked);
  });
}

function defineReportWrite(name: string, run: (admin: AdminRequest, report: DetailReport) => Promise<ReturnType<typeof jsonRendered>>): void {
  defineAdminRoute({
    method: "POST",
    pattern: `/internal/admin/piracy_reports/:id/${name}`,
    scope: PIRACY_SCOPE,
    run: async (admin) => {
      const report = await findReport(admin);
      if (report === null) return halted(failure(REPORT_NOT_FOUND, 404));
      return recordAdminWrite(admin, { action: `piracy_reports.${name}`, target: auditTarget(report), wrapper: WRAPPER }, () => run(admin, report));
    },
  });
}

defineReportWrite("start_screening", (_admin, report) =>
  withLock(report, async (tx, locked) => {
    if (locked.state !== "requested") {
      return jsonRendered({ success: false, message: `Cannot transition state via :start_screening from :${locked.state} (Reason(s): State cannot transition via "start screening")` }, 422);
    }
    const saved = await tx.piracyReport.update({ where: { id: locked.id }, data: { state: "screening", updated_at: new Date() }, include: { seller: true, product: true } });
    return jsonRendered({ success: true, report: serializeSummary(saved) });
  }),
);

type Check = { passed: boolean | null; reason: string };

// ScreenService::PASSED_VALUES: only a boolean or its string form counts.
const passedValue = (value: unknown): boolean | null => (value === true || value === "true" ? true : value === false || value === "false" ? false : null);

export function screeningInput(admin: AdminRequest) {
  const verdict = paramToS(admin.params.verdict, SOURCE);
  const given = isHash(admin.params.checks) ? admin.params.checks : {};
  const present = SCREENING_CHECKS.filter((key) => Object.hasOwn(given, key));
  const wellFormed = present.filter((key) => isHash(given[key]));
  const checks: Record<string, Check> = {};
  for (const key of wellFormed) {
    const entry = given[key] as Record<string, unknown>;
    checks[key] = { passed: passedValue(entry.passed), reason: rubyStrip(paramToS(entry.reason, SOURCE)) };
  }

  const errors: string[] = [];
  if (!SCREENING_VERDICTS.includes(verdict)) errors.push("verdict must be pass, fail or review");
  for (const key of Object.keys(given)) if (!SCREENING_CHECKS.includes(key)) errors.push(`unknown check ${key}`);
  for (const key of present) if (!wellFormed.includes(key)) errors.push(`check ${key} must be an object`);
  if (Object.keys(given).length === 0) errors.push("at least one check is required");
  for (const [key, entry] of Object.entries(checks)) {
    if (entry.passed === null) errors.push(`check ${key} passed must be true or false`);
    if (isBlank(entry.reason)) errors.push(`check ${key} needs a reason`);
    if (charLength(entry.reason) > MAX_REASON_LENGTH) errors.push(`check ${key} reason is too long`);
  }
  if (verdict === "pass") {
    const missing = SCREENING_CHECKS.filter((key) => !Object.hasOwn(checks, key));
    if (missing.length > 0) errors.push(`a pass verdict needs every check: missing ${missing.join(", ")}`);
    if (!Object.values(checks).every((entry) => entry.passed === true)) errors.push("every check must pass for a pass verdict");
  }
  if (verdict === "fail" && !Object.values(checks).some((entry) => entry.passed === false)) errors.push("a fail verdict needs at least one failed check");
  return { verdict, checks, errors };
}

defineReportWrite("screen", (admin, report) =>
  withLock(report, async (tx, locked) => {
    if (locked.state !== "screening") return unprocessable(["The report is not being screened"]);
    const { verdict, checks, errors } = screeningInput(admin);
    if (errors.length > 0) return unprocessable(errors);
    // A pass renders the notice from the recipient registry and mails the seller to sign it.
    if (verdict === "pass") throw new NotPortedError("a pass verdict (renders the notice and sends the signature request)", SOURCE);

    const now = new Date();
    const screeningChecks = verdict === "fail" ? { agent: checks, rails: [] } : { agent: checks };
    const data: Prisma.PiracyReportUpdateInput = { screening_verdict: verdict, screening_checks: screeningChecks as Prisma.InputJsonValue, screened_at: now, updated_at: now };
    if (verdict === "fail") data.state = "declined";
    const saved = await tx.piracyReport.update({ where: { id: locked.id }, data, include: { seller: true, product: true } });
    // The answer carries the checks in the order they were assigned; MySQL's JSON column reorders keys on the way back.
    return jsonRendered({ success: true, report: await serializeDetail({ ...saved, screening_checks: screeningChecks as Prisma.JsonObject }) });
  }),
);

export function parseIsoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

const shiftDays = (date: Date, days: number): string => new Date(date.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);

defineReportWrite("counter_notice", (admin, report) =>
  withLock(report, async (_tx, locked) => {
    // A recorded counter-notice whose forward never went out is finished by mailing the seller.
    if (locked.state === "counter_noticed" && locked.counter_notice_forwarded_at === null) throw new NotPortedError("the retry of a counter-notice forward (mails the seller)", SOURCE);
    if (!isBlank(locked.counter_notice_body)) return unprocessable(["A counter-notice is already recorded for this report"]);
    const open = locked.state === "sent" || (locked.state === "resolved" && REOPENABLE_OUTCOMES.includes(locked.outcome ?? ""));
    if (!open) return unprocessable(["The report has no notice out with a host"]);
    if (locked.sent_at === null) throw new NotPortedError("a sent report without a sent_at", SOURCE);

    const body = typeof admin.params.body === "string" ? rubyStrip(admin.params.body) : "";
    const received = parseIsoDate(paramToS(admin.params.received_on, SOURCE));
    const errors: string[] = [];
    if (isBlank(body)) errors.push("body is required");
    if (charLength(body) > MAX_COUNTER_NOTICE_LENGTH || Buffer.byteLength(body) > MAX_COUNTER_NOTICE_BYTES) errors.push("body is too long");
    if (received === null || received < shiftDays(locked.sent_at, -1) || received > shiftDays(new Date(), 1)) errors.push("received_on must be a YYYY-MM-DD date between the send date and today");
    if (errors.length > 0) return unprocessable(errors);
    throw new NotPortedError("a counter-notice (records it and mails the seller)", SOURCE);
  }),
);

defineReportWrite("resolve", (admin, report) =>
  withLock(report, async (_tx, locked) => {
    const outcome = paramToS(admin.params.outcome, SOURCE);
    const reason = rubyStrip(paramToS(admin.params.reason, SOURCE));
    if (locked.state === "resolved" && locked.outcome === outcome && locked.outcome_notified_at === null) throw new NotPortedError("the retry of an outcome email", SOURCE);
    if (locked.state === "resolved") return unprocessable(["The report already has an outcome"]);
    if (!["sent", "counter_noticed"].includes(locked.state)) return unprocessable(["The report has no notice out with a host"]);

    const errors: string[] = [];
    if (!OUTCOMES.includes(outcome)) errors.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
    if (outcome === "withdrawn" && isBlank(reason)) errors.push("a withdrawn report needs a reason");
    if (outcome === "restored" && locked.state !== "counter_noticed") errors.push("restored needs a recorded counter-notice");
    if (charLength(reason) > MAX_OUTCOME_REASON_LENGTH) errors.push("reason is too long");
    if (errors.length > 0) return unprocessable(errors);
    throw new NotPortedError("an outcome (records it and mails the seller)", SOURCE);
  }),
);

// PiracyReport.parse_http_url, for the URLs HTTP_URL reads the way URI.parse does. A string that is not an http(s) URL under any reading
// answers null; one that starts like one but falls outside the pattern is handed back.
export function parseHttpUrl(value: string): Parsed | null {
  const match = HTTP_URL.exec(value);
  if (match === null) {
    if (/^http/iu.test(value)) throw new NotPortedError("a URL Ruby's URI parser may read differently", SOURCE);
    return null;
  }
  const scheme = match[1]!.toLowerCase();
  return { scheme, host: match[2]!, port: match[3] === undefined ? DEFAULT_PORTS[scheme]! : Number(match[3]), path: match[4]!, query: match[5] ?? null };
}

// PiracyReport.normalized_host
const normalizedHost = (host: string): string => host.toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");

// PiracyReport.normalize_url: two spellings of the same page collide on the unique index.
export function normalizeUrl(uri: Parsed): string {
  let path = uri.path === "" ? "/" : uri.path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const pairs = (uri.query ?? "").split("&");
  while (pairs.length > 0 && pairs.at(-1) === "") pairs.pop();
  const query = pairs.sort().join("&");
  const port = uri.port === DEFAULT_PORTS[uri.scheme] ? "" : `:${uri.port}`;
  return `${normalizedHost(uri.host)}${port}${path}${query === "" ? "" : `?${query}`}`;
}

// PiracyReport.gumroad_domains: DEFAULT_EMAIL_DOMAIN is not in the Node domain config.
function gumroadDomains(): string[] {
  const config = domainConfig(process.env);
  const env = railsEnv();
  const emailDomain = env === "production" ? "gumroad.com" : env === "test" ? "test.gumroad.com" : "staging.gumroad.com";
  return [...new Set([config.rootDomain, config.shortDomain, config.discoverDomain, config.apiDomain, emailDomain].map((domain) => domain.split(":")[0]!.toLowerCase()))];
}

// PiracyReport.gumroad_hosted?: a seller's custom domain is hosted by Gumroad too.
async function gumroadHosted(host: string): Promise<boolean> {
  const normalized = normalizedHost(host);
  if (gumroadDomains().some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))) return true;
  return (await db.customDomain.count({ where: { deleted_at: null, domain: { in: [normalized, `www.${normalized}`] } } })) > 0;
}

function newExternalId(): string {
  return Array.from({ length: EXTERNAL_ID_LENGTH }, () => EXTERNAL_ID_ALPHABET[randomInt(EXTERNAL_ID_ALPHABET.length)]).join("");
}

const startOfMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/piracy_reports",
  scope: PIRACY_SCOPE,
  run: async (admin) => {
    const found = await findUserForWrite(admin, false);
    if ("refusal" in found) return found.refusal;
    const { user } = found;

    const productId = decrypt(paramToS(admin.params.product_id, SOURCE));
    const product = productId === null ? null : await db.link.findFirst({ where: { id: BigInt(productId), user_id: user.id, purchase_disabled_at: null, banned_at: null, deleted_at: null } });
    if (product === null) return failure("Product not found", 404);

    return recordAdminWrite(admin, { action: "piracy_reports.create", target: { type: "User", id: user.id, externalId: user.external_id }, wrapper: WRAPPER }, async () => {
      const url = rubyStrip(paramToS(admin.params.url, SOURCE));
      const ticket = admin.params.ticket_url;
      if (ticket !== undefined && ticket !== null && typeof ticket !== "string") throw new NotPortedError("a ticket_url that is not text", SOURCE);
      const ticketUrl = typeof ticket === "string" && !isBlank(ticket) ? ticket : null;

      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
        const seller = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        const errors = await eligibilityErrors(seller, product);

        const uri = parseHttpUrl(url);
        if (uri === null) errors.push("The URL must start with http:// or https://");
        else if (await gumroadHosted(uri.host)) errors.push(HOSTED_ON_GUMROAD_ERROR);
        else {
          const digest = createHash("sha256").update(normalizeUrl(uri)).digest("hex");
          if ((await tx.piracyReport.count({ where: { product_id: product.id, normalized_url_digest: digest } })) > 0) errors.push("This page has already been reported for this product");
        }
        const now = new Date();
        if ((await tx.piracyReport.count({ where: { seller_id: seller.id, created_at: { gte: startOfMonth(now) } } })) >= MONTHLY_LIMIT) errors.push(`The monthly limit of ${MONTHLY_LIMIT} reports has been reached`);
        if (errors.length > 0) return unprocessable(errors);

        // The model's own validations (lengths, a second URL inside the path) answer with Rails' messages.
        const embedsAnotherUrl = /https?(?::|%3a)/iu.test(url.replace(/^https?:\/\/[^/?#]*/iu, ""));
        if (charLength(url) > MAX_REPORTED_URL_LENGTH || (ticketUrl !== null && charLength(ticketUrl) > MAX_TICKET_URL_LENGTH) || embedsAnotherUrl) {
          throw new NotPortedError("a report the model would refuse", SOURCE);
        }
        let externalId = newExternalId();
        while ((await tx.piracyReport.count({ where: { external_id: externalId } })) > 0) externalId = newExternalId();
        const created = await tx.piracyReport.create({
          data: { external_id: externalId, seller_id: seller.id, product_id: product.id, source: "support", ticket_url: ticketUrl, state: "requested", url, normalized_url_digest: createHash("sha256").update(normalizeUrl(uri!)).digest("hex"), created_at: now, updated_at: now },
          include: { seller: true, product: true },
        });
        return jsonRendered({ success: true, report: serializeSummary(created) }, 201);
      });
    });
  },
});

