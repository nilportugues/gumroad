// Port of DirectAffiliate#schedule_workflow_jobs (app/models/direct_affiliate.rb): the SendWorkflowInstallmentWorker jobs
// an affiliate's new product assignments trigger. The reads run in Ruby's order and the pushes are returned, not made, so
// that a case Node cannot judge hands the job back before anything is queued for this affiliate.
// Golden: worker/jobs/__fixtures__/schedule-affiliate-workflows.golden.json (scripts/golden/schedule-affiliate-workflows.rb).
import { Prisma, type Link, type ProductAffiliate, type User } from "@prisma/client";

import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";

import { audienceMembersFilterParams } from "./installment-audience.ts";
import { InstallmentPost } from "./installment-post.ts";
import { nilReceiver } from "./offer-code.ts";
import { PRODUCT_AFFILIATES } from "./product-affiliate.ts";
import { findById } from "./row-reads.ts";
import { castRow, column, columnIn, quoteName, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";
import { parseJsonData, filterValue } from "./with-filtering.ts";
import { SEND_WORKFLOW_INSTALLMENT_WORKER } from "./workflow-scheduling.ts";
import { aliveInstallments, aliveWorkflowsOfSeller, type WorkflowRecord } from "./workflow.ts";

export { SEND_WORKFLOW_INSTALLMENT_WORKER };

export type AffiliateRow = {
  id: number;
  seller_id: number | null;
  affiliate_user_id: number | null;
  created_at: Date | null;
  deleted_at: Date | null;
  flags: number;
  type: string;
};
export type AssignmentPush = { at: Date; args: JsonValue[] };

const SEND_POSTS_FLAG = 2;
const SECOND_MS = 1000;
const AFFILIATE_WORKFLOW_TYPES = ["affiliate", "audience"] as const;

// `send_posts` (`has_flags 2 => :send_posts`)
export const sendsPosts = (affiliate: Pick<AffiliateRow, "flags">) => (affiliate.flags & SEND_POSTS_FLAG) !== 0;

const truncatedToSecond = (time: Date) => new Date(Math.floor(time.getTime() / SECOND_MS) * SECOND_MS);

// `ProductAffiliate.where(affiliate_id: id).includes(:product).to_a`
async function assignmentsWithProducts(
  affiliateId: number,
): Promise<{ assignment: ProductAffiliate; product: Link | null }[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PRODUCT_AFFILIATES)}.*`)} FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${affiliateId}`,
  );
  const assignments = rows.map((row) => castRow<ProductAffiliate>("ProductAffiliate", row));
  return withProducts(assignments);
}

// The `includes(:product)` preload: one query for the distinct products, when there are any.
export async function withProducts(
  assignments: ProductAffiliate[],
): Promise<{ assignment: ProductAffiliate; product: Link | null }[]> {
  const ids = [
    ...new Set(assignments.map((assignment) => assignment.link_id).filter((id): id is number => id !== null)),
  ];
  const products = new Map<number, Link>();
  if (ids.length > 0) {
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${columnIn("links", "id", ids)}`,
    );
    for (const row of rows) products.set(Number((row as { id: number }).id), castRow<Link>("Link", row));
  }
  return assignments.map((assignment) => ({
    assignment,
    product: assignment.link_id === null ? null : (products.get(assignment.link_id) ?? null),
  }));
}

// The `includes(:affiliate)` preload of the assignments a token holds: the affiliates by id, with the columns
// ActiveRecord lists for them.
export async function preloadAffiliates(assignments: ProductAffiliate[]): Promise<Map<number, AffiliateRow>> {
  const ids = [
    ...new Set(assignments.map((assignment) => assignment.affiliate_id).filter((id): id is number => id !== null)),
  ];
  const affiliates = new Map<number, AffiliateRow>();
  if (ids.length === 0) return affiliates;
  const columns = [
    "id",
    "seller_id",
    "affiliate_user_id",
    "affiliate_basis_points",
    "created_at",
    "updated_at",
    "deleted_at",
    "flags",
    "destination_url",
    "type",
  ].map((name) => column("affiliates", name));
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.join(columns, ", ")} FROM ${table("affiliates")} WHERE ${columnIn("affiliates", "id", ids)}`,
  );
  for (const row of rows)
    affiliates.set(
      Number((row as { id: number }).id),
      castRow<AffiliateRow & Record<string, unknown>>("Affiliate", row),
    );
  return affiliates;
}

// `identity_matches_workflow_dates?(installment)`: the affiliate must have joined within the post's dates.
async function identityMatchesWorkflowDates(affiliate: AffiliateRow, post: InstallmentPost): Promise<boolean> {
  const filters = await audienceMembersFilterParams(post);
  const createdAfter = filters.created_after ? new Date(filters.created_after) : null;
  const createdBefore = filters.created_before ? new Date(filters.created_before) : null;
  if (createdAfter === null && createdBefore === null) return true;
  if (affiliate.created_at === null) throw new NotPortedError("an affiliate without created_at", "direct_affiliate.rb");
  if (createdAfter !== null && affiliate.created_at.getTime() <= createdAfter.getTime()) return false;
  if (createdBefore !== null && affiliate.created_at.getTime() >= createdBefore.getTime()) return false;
  return true;
}

// `workflow_triggers(installment:, product_affiliates:, triggering_product_affiliate_ids:)`
function workflowTriggers(
  post: InstallmentPost,
  assignments: { assignment: ProductAffiliate; product: Link | null }[],
  triggeringIds: Set<number>,
): ProductAffiliate[] {
  const affiliateProducts = filterValue({ jsonData: () => parseJsonData(post.row.json_data) }, "affiliate_products");
  let candidates = assignments;
  if (affiliateProducts !== null) {
    if (!Array.isArray(affiliateProducts) || affiliateProducts.some((permalink) => typeof permalink !== "string"))
      throw new NotPortedError("affiliate_products that is not a list of strings", "direct_affiliate.rb");
    const permalinks = new Set(affiliateProducts as string[]);
    candidates = assignments.filter(({ product }) => {
      if (product === null) throw nilReceiver("unique_permalink");
      return permalinks.has(product.unique_permalink ?? "");
    });
  }
  const groups = new Map<number, ProductAffiliate[]>();
  for (const { assignment } of candidates) {
    if (assignment.created_at === null) continue;
    const key = truncatedToSecond(assignment.created_at).getTime();
    groups.set(key, [...(groups.get(key) ?? []), assignment]);
  }
  const triggers: ProductAffiliate[] = [];
  for (const equivalent of groups.values()) {
    const trigger = equivalent.reduce((first, other) => (other.id < first.id ? other : first));
    if (triggeringIds.has(trigger.id)) triggers.push(trigger);
  }
  return triggers;
}

// `schedule_workflow_jobs(triggering_product_affiliates:)`: the pushes, in the order Ruby makes them.
export async function scheduleWorkflowJobs(
  affiliate: AffiliateRow,
  triggering: ProductAffiliate[],
): Promise<AssignmentPush[]> {
  const seller = await findById<User>("User", affiliate.seller_id);
  if (seller === null) throw nilReceiver("workflows");
  const triggeringIds = new Set(triggering.map((assignment) => assignment.id));
  const assignments = await assignmentsWithProducts(affiliate.id);
  const pushes: AssignmentPush[] = [];
  let affiliateUser: User | null | undefined;
  const workflows: WorkflowRecord[] = await aliveWorkflowsOfSeller(seller.id, AFFILIATE_WORKFLOW_TYPES);
  for (const workflow of workflows) {
    if (!workflow.newCustomerTrigger) continue;
    for (const installment of await aliveInstallments(workflow.id, { published: false })) {
      const post = new InstallmentPost(installment);
      if (!(await identityMatchesWorkflowDates(affiliate, post))) continue;
      const installmentRule = await post.installmentRule();
      if (installmentRule === null) continue;
      for (const trigger of workflowTriggers(post, assignments, triggeringIds)) {
        const reference = truncatedToSecond(trigger.created_at!);
        if (installmentRule.delayed_delivery_time === null)
          throw new NotPortedError("an installment rule without a delay", "installment_rule.rb");
        if (affiliateUser === undefined) affiliateUser = await findById<User>("User", affiliate.affiliate_user_id);
        if (affiliateUser === null) throw nilReceiver("id");
        pushes.push({
          at: new Date(reference.getTime() + installmentRule.delayed_delivery_time * SECOND_MS),
          args: [
            installment.id,
            installmentRule.version,
            null,
            null,
            Number(affiliateUser.id),
            null,
            iso8601(reference),
          ],
        });
      }
    }
  }
  return pushes;
}

// `Time#iso8601` of a UTC time with no fraction
const iso8601 = (time: Date) => time.toISOString().replace(".000Z", "Z");
