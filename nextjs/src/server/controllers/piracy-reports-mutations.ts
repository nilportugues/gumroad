// PiracyReportsController#create, #sign and #cancel (app/controllers/piracy_reports_controller.rb); the pages are in
// page-props/piracy-reports/pages.ts.
//
// Ported: every refusal and redirect, #sign (the checks, the signature text and the row update) and #cancel (a row lock and a state
// change); neither mails or queues anything.
// Handed to Rails before any write:
//   - #create of a report that passes the guards: it draws the report's random external id;
//   - a signature or cancellation of a row the model would refuse to save, a request without a client address to record, and a
//     parameter that is not text.
import { createHash } from "node:crypto";

import type { Link, Prisma } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { db } from "../../lib/db.ts";
import { NotPortedError } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import {
  CANCELLABLE_STATES,
  eligibilityErrors,
  findProduct,
  findReport,
  guard,
  MONTHLY_LIMIT,
  policyAdmin,
  policyCreate,
  productsRedirect,
  SIGNATURE_CONFIRMATIONS,
  SIGNATURE_STATEMENT_VERSION,
} from "../page-props/piracy-reports/pages.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { gumroadHosted, normalizeUrl, parseHttpUrl } from "./internal-admin/piracy-report-writes.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const MAX_SIGNED_BY_NAME_LENGTH = 255;
const MAX_REPORTED_URL_LENGTH = 500;
const MAX_RECIPIENT_EMAIL_LENGTH = 254;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// String#squish collapses [[:space:]], which includes U+0085 and the Unicode spaces that JavaScript's \s misses or adds.
const RUBY_SPACE = "\\t-\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const RUBY_SPACE_RUN = new RegExp(`[${RUBY_SPACE}]+`, "gu");
const BLANK = new RegExp(`^[${RUBY_SPACE}]*$`, "u");
const FORMAT_CHARACTERS = /\p{Cf}/gu;

const charLength = (value: string): number => [...value].length;

// String#strip
const rubyStrip = (value: string): string => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");

// String#squish
const squish = (value: string): string => rubyStrip(value.replace(RUBY_SPACE_RUN, " "));

// Array#to_sentence
function toSentence(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// `params[:x].to_s` for a value that is text or missing; Ruby prints anything else (an Array, a Hash) in a way Node does not reproduce.
function textParam(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  throw new HandBackToRails("a parameter that is not text, which Rails prints with #to_s");
}

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

const redirectTo = (location: string, flash: { notice: string } | { alert: string }): ActionResult => ({
  status: FOUND,
  location,
  flash,
});
const reportPath = (externalId: string) => Routes.piracy_report_path(externalId);

// The row validations a save would run (PiracyReport's validates and url_is_http_url). A row that fails them makes Rails raise or
// answer with its own errors, so it goes to Rails whole.
function assertSavable(report: { url: string; recipient_email: string | null }): void {
  const url = report.url;
  const embedsAnotherUrl = /https?(?::|%3a)/iu.test(url.trim().replace(/^https?:\/\/[^/?#]*/iu, ""));
  const valid =
    charLength(url) <= MAX_REPORTED_URL_LENGTH &&
    parseHttpUrl(url) !== null &&
    !embedsAnotherUrl &&
    (report.recipient_email === null || charLength(report.recipient_email) <= MAX_RECIPIENT_EMAIL_LENGTH);
  if (!valid) throw new NotPortedError("a report the model would refuse to save", "PiracyReport validations");
}

// PiracyReports::CreateService#guard_errors; the order is the order Rails lists them in.
async function createErrors(input: MutationInput, product: Link): Promise<string[]> {
  const seller = input.context.currentSeller!;
  const errors = await eligibilityErrors(seller, product);
  const url = rubyStrip(textParam(input.params.url));

  const uri = parseHttpUrl(url);
  if (uri === null) errors.push("The URL must start with http:// or https://");
  else if (await gumroadHosted(uri.host))
    errors.push("Pages hosted on Gumroad are reported through the terms of service process");
  else {
    const digest = createHash("sha256").update(normalizeUrl(uri)).digest("hex");
    if ((await db.piracyReport.count({ where: { product_id: product.id, normalized_url_digest: digest } })) > 0) {
      errors.push("This page has already been reported for this product");
    }
  }

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (
    (await db.piracyReport.count({ where: { seller_id: seller.id, created_at: { gte: startOfMonth } } })) >=
    MONTHLY_LIMIT
  ) {
    errors.push(`The monthly limit of ${MONTHLY_LIMIT} reports has been reached`);
  }
  return errors;
}

// POST /dashboard/piracy_reports
async function create(input: MutationInput): Promise<ActionResult> {
  const permalink = textParam(input.params.product_id);
  const refused = await guard(
    guardInput(input),
    async (context) => ((await findProduct(context.seller!, permalink)) ? null : productsRedirect("Product not found")),
    policyCreate,
  );
  if (refused) return refused;

  const product = (await findProduct(input.context.currentSeller!, permalink))!;
  const errors = await createErrors(input, product);
  if (errors.length > 0) {
    return redirectTo(Routes.new_piracy_report_path({ product_id: permalink }), { alert: toSentence(errors) });
  }
  throw new HandBackToRails("a new report, whose external id is drawn at random");
}

type Confirmations = string[];

// `Array(confirmations).map(&:to_s)`
function confirmationsParam(value: unknown): Confirmations {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  throw new HandBackToRails(
    "confirmations that are not a list of text, which Rails flattens in ways Node does not reproduce",
  );
}

async function lockedReport(tx: Prisma.TransactionClient, id: bigint) {
  await tx.$queryRaw`SELECT id FROM piracy_reports WHERE id = ${id} FOR UPDATE`;
  return tx.piracyReport.findUniqueOrThrow({ where: { id } });
}

// POST /dashboard/piracy_reports/:id/sign
async function sign(input: MutationInput): Promise<ActionResult> {
  const externalId = input.routeParams.id!;
  const refused = await guard(
    guardInput(input),
    async (context) => ((await findReport(context.seller!, externalId)) ? null : productsRedirect("Report not found")),
    policyAdmin,
  );
  if (refused) return refused;

  const name = textParam(input.params.signed_by_name);
  const confirmations = confirmationsParam(input.params.confirmations);
  const statementVersion = textParam(input.params.confirmations_version);
  const found = (await findReport(input.context.currentSeller!, externalId))!;
  const ip = remoteIp(input.request);

  const alert = await db.$transaction(async (tx) => {
    // PiracyReport#record_signature!, inside with_lock: the row is reloaded, so a second submit sees the first one's result.
    const report = await lockedReport(tx, found.id);
    const errors: string[] = [];
    if (report.state !== "awaiting_signature") errors.push("This report is not ready to sign");
    if (report.notice_text === null || BLANK.test(report.notice_text))
      errors.push("The notice has not been generated yet");
    if (!SIGNATURE_CONFIRMATIONS.every(([key]) => confirmations.includes(key)))
      errors.push("Check every confirmation to sign");
    if (statementVersion !== SIGNATURE_STATEMENT_VERSION)
      errors.push("The confirmations changed. Reload the page and read them again.");
    // Invisible format characters (zero-width, bidi overrides) could blank or disguise the signature.
    const signedByName = squish(name.replace(FORMAT_CHARACTERS, ""));
    if (signedByName === "") errors.push("Signed by name must be your full legal name");
    if (charLength(signedByName) > MAX_SIGNED_BY_NAME_LENGTH) errors.push("Signed by name is too long");
    if (errors.length > 0) return toSentence(errors);

    if (ip === null) throw new NotPortedError("a signature from a request with no client address", "request.remote_ip");
    assertSavable(report);
    const signedAt = new Date();
    const signedText = `${report.notice_text!.replace(/[\0\t\n\v\f\r ]+$/u, "")}\n\nSigned: /s/ ${signedByName}, ${MONTHS[signedAt.getUTCMonth()]} ${signedAt.getUTCDate()}, ${signedAt.getUTCFullYear()}\n`;
    await tx.piracyReport.update({
      where: { id: report.id },
      data: {
        signed_by_name: signedByName,
        signed_at: signedAt,
        signed_ip: ip,
        signature_statement_version: SIGNATURE_STATEMENT_VERSION,
        notice_text: signedText,
        notice_digest: createHash("sha256").update(signedText).digest("hex"),
        state: "signed",
        updated_at: signedAt,
      },
    });
    return null;
  });

  if (alert !== null) return redirectTo(reportPath(externalId), { alert });
  return redirectTo(reportPath(externalId), { notice: "Signed. We will send the notice." });
}

// POST /dashboard/piracy_reports/:id/cancel
async function cancel(input: MutationInput): Promise<ActionResult> {
  const externalId = input.routeParams.id!;
  const refused = await guard(
    guardInput(input),
    async (context) => ((await findReport(context.seller!, externalId)) ? null : productsRedirect("Report not found")),
    policyAdmin,
  );
  if (refused) return refused;

  const found = (await findReport(input.context.currentSeller!, externalId))!;
  const state = await db.$transaction(async (tx) => {
    const report = await lockedReport(tx, found.id);
    // A second tab may confirm after the first one cancelled, so an already-cancelled report is a success.
    if (report.state !== "cancelled" && CANCELLABLE_STATES.includes(report.state)) {
      assertSavable(report);
      await tx.piracyReport.update({ where: { id: report.id }, data: { state: "cancelled", updated_at: new Date() } });
      return "cancelled";
    }
    return report.state;
  });

  const path = reportPath(externalId);
  if (state === "cancelled") return redirectTo(path, { notice: "Report cancelled. Nothing was sent." });
  if (state === "declined")
    return redirectTo(path, { alert: "We did not send this report, so there is nothing to cancel." });
  return redirectTo(path, { alert: "This notice was already sent, so the report cannot be cancelled." });
}

registerMutations(
  { method: "POST", pattern: "/dashboard/piracy_reports", run: create },
  { method: "POST", pattern: "/dashboard/piracy_reports/:id/sign", run: sign },
  { method: "POST", pattern: "/dashboard/piracy_reports/:id/cancel", run: cancel },
);
