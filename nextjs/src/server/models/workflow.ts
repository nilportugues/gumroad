// Read side of app/models/workflow.rb: the `alive` / type scopes the jobs list workflows with,
// `applies_to_purchase?`, the trigger predicates, and the installments and rules a workflow schedules.
// A `WorkflowRecord` mirrors one loaded ActiveRecord object: `seller` and `base_variant` load once.
// Nothing here writes. Golden: worker/jobs/__fixtures__/workflow-jobs.golden.json.
import { Prisma, type BaseVariant, type Installment, type InstallmentRule, type User, type Workflow } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import type { YamlValue } from "./concerns/psych.ts";
import type { PurchaseRecord } from "./purchase-pricing.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { castRow, column, columnIn, quoteName, selectRows, table } from "./sql.ts";
import { ABANDONED_CART_TYPE, AUDIENCE_TYPE, filterValue, parseJsonData, purchasePassesFilters, PRODUCT_TYPE, RECIPIENT_TYPES, SELLER_TYPE, VARIANT_TYPE, type Filterable, readFilters } from "./with-filtering.ts";

export const WORKFLOWS = "workflows";
export const INSTALLMENTS = "installments";
export const INSTALLMENT_RULES = "installment_rules";
export const MEMBER_CANCELLATION_WORKFLOW_TRIGGER = "member_cancellation";

export const WorkflowFlags = defineFlags("workflows", { 1: "send_to_past_customers" }, { queryMode: "bit_operator" });

// Integer columns come back as numbers or bigints depending on the column; ids compare by value.
const sameId = (a: bigint | number | null, b: bigint | number | null) => (a === null || b === null ? a === b : BigInt(a) === BigInt(b));

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);

export class WorkflowRecord implements Filterable {
  row: Workflow;
  memo: Map<string, Promise<unknown>>;
  private json: Record<string, YamlValue> | undefined;

  constructor(row: Workflow) {
    this.row = row;
    this.memo = new Map();
  }

  get id(): number {
    return this.row.id;
  }

  // `json_data`, parsed on first use: a column that is not a Hash raises there, not at load.
  jsonData(): Record<string, YamlValue> {
    this.json ??= parseJsonData(this.row.json_data);
    return this.json;
  }

  recipientType(): string | null {
    return this.row.workflow_type;
  }

  // `belongs_to :seller`
  seller(): Promise<User | null> {
    let value = this.memo.get("seller") as Promise<User | null> | undefined;
    if (value === undefined) {
      value = findById<User>("User", this.row.seller_id);
      this.memo.set("seller", value);
    }
    return value;
  }

  // `belongs_to :base_variant`
  baseVariant(): Promise<BaseVariant | null> {
    let value = this.memo.get("base_variant") as Promise<BaseVariant | null> | undefined;
    if (value === undefined) {
      value = findById<BaseVariant>("BaseVariant", this.row.base_variant_id);
      this.memo.set("base_variant", value);
    }
    return value;
  }

  // ----- types (WithFiltering)

  get productType(): boolean {
    return this.row.workflow_type === PRODUCT_TYPE;
  }

  get variantType(): boolean {
    return this.row.workflow_type === VARIANT_TYPE;
  }

  get audienceType(): boolean {
    return this.row.workflow_type === AUDIENCE_TYPE;
  }

  get abandonedCartType(): boolean {
    return this.row.workflow_type === ABANDONED_CART_TYPE;
  }

  // `send_to_past_customers?`
  get sendToPastCustomers(): boolean {
    return WorkflowFlags.isSet(this.row.flags, "send_to_past_customers");
  }

  // `workflow_trigger` (`attr_json_data_accessor`)
  get workflowTrigger(): YamlValue {
    return filterValue(this, "workflow_trigger");
  }

  // `new_customer_trigger?`
  get newCustomerTrigger(): boolean {
    return this.workflowTrigger === null;
  }

  // `member_cancellation_trigger?`
  get memberCancellationTrigger(): boolean {
    return this.workflowTrigger === MEMBER_CANCELLATION_WORKFLOW_TRIGGER;
  }

  // `applies_to_purchase?(purchase)`
  async appliesToPurchase(purchase: PurchaseRecord): Promise<boolean> {
    if (this.productType && !sameId(this.row.link_id, purchase.row.link_id)) return false;
    if (this.variantType && !(await includesVariant(purchase, await this.baseVariant()))) return false;
    return purchasePassesFilters(this, purchase);
  }
}

// `purchase.variant_attributes.include?(variant)`: nil is never included and asks nothing; a loaded
// association answers in memory, otherwise one existence query.
async function includesVariant(purchase: PurchaseRecord, variant: BaseVariant | null): Promise<boolean> {
  if (variant === null) return false;
  if (purchase.memo.has("variant_attributes")) return (await purchase.variantAttributes()).some((candidate) => candidate.row.id === variant.id);
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id} AND ${column("base_variants", "id")} = ${variant.id} LIMIT 1`,
  );
  return rows.length > 0;
}

const records = (rows: Record<string, unknown>[]) => rows.map((row) => new WorkflowRecord(castRow<Workflow>("Workflow", row)));

// `link.workflows.alive`
export async function aliveWorkflowsOfLink(linkId: bigint | number): Promise<WorkflowRecord[]> {
  return records(await selectRows(Prisma.sql`SELECT ${star(WORKFLOWS)} FROM ${table(WORKFLOWS)} WHERE ${column(WORKFLOWS, "link_id")} = ${linkId} AND ${column(WORKFLOWS, "deleted_at")} IS NULL`));
}

// `seller.workflows.alive.<type scope>`
export async function aliveWorkflowsOfSeller(sellerId: bigint | number, types: readonly string[]): Promise<WorkflowRecord[]> {
  return records(
    await selectRows(
      Prisma.sql`SELECT ${star(WORKFLOWS)} FROM ${table(WORKFLOWS)} WHERE ${column(WORKFLOWS, "seller_id")} = ${sellerId} AND ${column(WORKFLOWS, "deleted_at")} IS NULL AND ${columnIn(WORKFLOWS, "workflow_type", types)}`,
    ),
  );
}

export { RECIPIENT_TYPES, SELLER_TYPE };

// `workflow.installments.alive[.published]`
export async function aliveInstallments(workflowId: number, { published }: { published: boolean }): Promise<Installment[]> {
  const publishedClause = published ? Prisma.sql` AND ${column(INSTALLMENTS, "published_at")} IS NOT NULL` : Prisma.empty;
  const rows = await selectRows(
    Prisma.sql`SELECT ${star(INSTALLMENTS)} FROM ${table(INSTALLMENTS)} WHERE ${column(INSTALLMENTS, "workflow_id")} = ${workflowId} AND ${column(INSTALLMENTS, "deleted_at")} IS NULL${publishedClause}`,
  );
  return rows.map((row) => castRow<Installment>("Installment", row));
}

// `installment.installment_rule` (`has_one`)
export function installmentRuleOf(installmentId: number): Promise<InstallmentRule | null> {
  return findOneBy<InstallmentRule>("InstallmentRule", "installment_id", installmentId);
}

// Whether a workflow's filters are ones Node can judge, without reading anything: a job calls this
// for the workflows it will evaluate after its first write, to hand itself back first.
export function assertWorkflowSupported(row: Workflow): void {
  readFilters(new WorkflowRecord(row));
}
