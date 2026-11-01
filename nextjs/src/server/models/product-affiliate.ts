// Read side and dispatch lease of app/models/product_affiliate.rb: the workflow schedule tokens that
// ScheduleAffiliateWorkflowJobsJob re-dispatches. A token is claimed by rewriting it to
// "<unix time>:<uuid>"; a claim older than the lease is taken over again. Creating assignments (which
// assigns the first token) stays in Ruby. Golden: worker/jobs/__fixtures__/workflow-jobs.golden.json.
import { Prisma } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { advance } from "./concerns/ruby-time.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, columnIn, execute, selectRows, table } from "./sql.ts";

export const PRODUCT_AFFILIATES = "affiliates_links";
// ProductAffiliate::WORKFLOW_SCHEDULE_DISPATCH_LEASE
export const WORKFLOW_SCHEDULE_DISPATCH_LEASE = { minutes: 15 };
const SCHEDULE_AFFILIATE_WORKFLOW_JOBS_JOB = "ScheduleAffiliateWorkflowJobsJob";

export class WorkflowJobNotEnqueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductAffiliate::WorkflowJobNotEnqueuedError";
  }
}

export type AffiliateDeps = { now: () => Date; uuid: () => string; logError: (message: string) => void };

const tokenColumn = () => column(PRODUCT_AFFILIATES, "workflow_schedule_token");
const star = Prisma.raw(`\`${PRODUCT_AFFILIATES}\`.*`);

// `Integer(string, exception: false)`: Ruby's literal syntax for integers (a `0x`, `0b` or `0o`
// prefix, a leading `0` for octal, single underscores between digits) with surrounding whitespace.
export function rubyInteger(text: string): number | null {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0[bB][01]+(?:_[01]+)*|0[oO][0-7]+(?:_[0-7]+)*|0[0-7]*(?:_[0-7]+)*|[1-9]\d*(?:_\d+)*)[ \t\n\v\f\r]*$/u.exec(text);
  if (!match) return null;
  const digits = match[2]!.replaceAll("_", "");
  const prefix = digits.slice(0, 2).toLowerCase();
  const value = prefix === "0x" ? parseInt(digits.slice(2), 16) : prefix === "0b" ? parseInt(digits.slice(2), 2) : prefix === "0o" ? parseInt(digits.slice(2), 8) : digits.length > 1 && digits.startsWith("0") ? parseInt(digits, 8) : parseInt(digits, 10);
  return match[1] === "-" ? -value : value;
}

// `workflow_schedule_dispatchable?(token)`: a token that is not "<time>:..." was never claimed.
export function workflowScheduleDispatchable(token: string, now: Date): boolean {
  const claimedAt = rubyInteger(token.split(":")[0]!);
  return claimedAt === null || claimedAt * 1000 <= advance(now, { minutes: -WORKFLOW_SCHEDULE_DISPATCH_LEASE.minutes }).getTime();
}

// `where.not(workflow_schedule_token: nil).group(:workflow_schedule_token).minimum(:id)`, the tokens in the
// order MySQL answers.
export async function pendingWorkflowScheduleTokens(): Promise<string[]> {
  const rows = await selectRows<{ minimum_id: unknown; affiliates_links_workflow_schedule_token: string }>(
    Prisma.sql`SELECT MIN(${column(PRODUCT_AFFILIATES, "id")}) AS \`minimum_id\`, ${tokenColumn()} AS \`affiliates_links_workflow_schedule_token\` FROM ${table(PRODUCT_AFFILIATES)} WHERE ${tokenColumn()} IS NOT NULL GROUP BY ${tokenColumn()}`,
  );
  return rows.map((row) => row.affiliates_links_workflow_schedule_token);
}

// `where(workflow_schedule_token:).includes(:affiliate, :product).to_a`, the assignments' own rows
// (the preloads are not ported).
export async function assignmentsOfToken(token: string): Promise<{ id: number }[]> {
  return selectRows<{ id: number }>(Prisma.sql`SELECT ${star} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${tokenColumn()} = ${token}`);
}

// `claim_workflow_schedule(token)`: the new token, or null when no assignment holds the old one.
async function claimWorkflowSchedule(token: string, deps: Pick<AffiliateDeps, "now" | "uuid">): Promise<string | null> {
  return transaction(async () => {
    const assignments = await selectRows<{ id: number }>(Prisma.sql`SELECT ${star} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${tokenColumn()} = ${token} FOR UPDATE`);
    if (assignments.length === 0) return null;
    const claimed = `${Math.floor(deps.now().getTime() / 1000)}:${deps.uuid()}`;
    await execute(
      Prisma.sql`UPDATE ${table(PRODUCT_AFFILIATES)} SET ${tokenColumn()} = ${claimed} WHERE ${columnIn(PRODUCT_AFFILIATES, "id", assignments.map((row) => row.id))} AND ${tokenColumn()} = ${token}`,
    );
    return claimed;
  });
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// `enqueue_workflow_schedule(token)`: the job id, or null. Never raises: a failure is logged and the
// claim given back, so the next sweep tries again.
export async function enqueueWorkflowSchedule(token: string, deps: AffiliateDeps): Promise<string | null> {
  let claimed: string | null = null;
  try {
    claimed = await claimWorkflowSchedule(token, deps);
    if (claimed === null) return null;
    const jid = await performAsync(SCHEDULE_AFFILIATE_WORKFLOW_JOBS_JOB, [claimed]);
    if (!jid) throw new WorkflowJobNotEnqueuedError("Sidekiq did not enqueue the affiliate workflow");
    return jid;
  } catch (error) {
    deps.logError(`[ProductAffiliate] could not enqueue workflow_schedule_token=${token}: ${errorText(error)}`);
    try {
      if (claimed) await execute(Prisma.sql`UPDATE ${table(PRODUCT_AFFILIATES)} SET ${tokenColumn()} = ${token} WHERE ${tokenColumn()} = ${claimed}`);
    } catch (releaseError) {
      deps.logError(`[ProductAffiliate] could not release workflow_schedule_token=${claimed}: ${errorText(releaseError)}`);
    }
    return null;
  }
}
