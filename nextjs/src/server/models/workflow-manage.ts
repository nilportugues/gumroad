// Workflow::ManageService (app/services/workflow/manage_service.rb): creating and updating a workflow from the form, with its
// emails following the audience until the workflow has been published once. Golden: __fixtures__/save-installment.golden.json
// ("workflow" cases). Throws NotPortedError before the first write for a variant workflow and for the default abandoned cart
// email (DefaultAbandonedCartWorkflowGeneratorService), which the controller hands to Rails.
import { Prisma, type Installment, type Link, type User, type Workflow } from "@prisma/client";

import { InstallmentFlags } from "./installment-post.ts";
import { setAssociation } from "./concerns/rails-validations.ts";
import { jsonData } from "./concerns/json-data.ts";
import { Installments, InstallmentInvalid, markDeletedBang as markInstallmentDeletedBang } from "./installment-writes.ts";
import { addAndValidateFilters, permit, present } from "./save-installment.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, findInBatches, selectRows, table } from "./sql.ts";
import { eligibleForAbandonedCartWorkflows } from "./user-email-eligibility.ts";
import { NotPortedError } from "./user.ts";
import { PRODUCT_TYPE, VARIANT_TYPE } from "./with-filtering.ts";
import { WorkflowFlags } from "./workflow.ts";
import { installmentOf, publishBang, unpublishBang, Workflows } from "./workflow-writes.ts";

type WorkflowRecord = ModelRecord<Workflow>;
const ABANDONED_CART_TYPE = "abandoned_cart";
const BATCH_SIZE = 1000;
export const SAVE_AND_PUBLISH_ACTION = "save_and_publish";
export const SAVE_AND_UNPUBLISH_ACTION = "save_and_unpublish";

const SCALAR_KEYS = [
  "name",
  "workflow_type",
  "variant_external_id",
  "workflow_trigger",
  "paid_more_than",
  "paid_less_than",
  "bought_from",
  "created_after",
  "created_before",
  "permalink",
  "send_to_past_customers",
  "save_action_name",
] as const;
const ARRAY_KEYS = ["bought_products", "not_bought_products", "affiliate_products", "bought_variants", "not_bought_variants"] as const;

export const permitWorkflow = (raw: unknown): Record<string, unknown> => permit(raw, SCALAR_KEYS, ARRAY_KEYS);

const refuse = (what: string): never => {
  throw new NotPortedError(what, "workflow/manage_service.rb");
};

// FlagShihTzu::TRUE_VALUES
const TRUE_VALUES = [true, 1, "1", "t", "T", "true", "TRUE"];

const aliveInstallments = (workflow: WorkflowRecord, extra: Prisma.Sql | null = null) => {
  const base = Prisma.sql`${column("installments", "workflow_id")} = ${workflow.get("id")} AND ${column("installments", "deleted_at")} IS NULL`;
  return extra === null ? base : Prisma.sql`${base} AND ${extra}`;
};

export type ManageWorkflowResult = { ok: boolean; error: string | null; workflow: WorkflowRecord };

export async function manageWorkflow(
  input: { seller: User; params: Record<string, unknown>; product: Link | null; workflow: WorkflowRecord | null },
  options: { now?: () => Date; uuid?: () => string } = {},
): Promise<ManageWorkflowResult> {
  const { seller, params, product } = input;
  const type = params.workflow_type;
  const productOrVariant = type === PRODUCT_TYPE || type === VARIANT_TYPE;
  let workflow = input.workflow;
  if (workflow === null) {
    workflow = Workflows.build(productOrVariant ? { seller_id: Number(product!.user_id), link_id: Number(product!.id) } : { seller_id: Number(seller.id) });
    // product.workflows.build(seller: product.user) sets the association; seller.workflows.build leaves it for the validation to load.
    if (productOrVariant) setAssociation(workflow, "seller", workflow.get("seller_id"), seller);
  }
  const record = workflow;
  const now = options.now;
  const name = params.name;
  record.set("name", name === undefined || name === null ? null : typeof name === "string" ? name : refuse("a workflow name that is not text"));

  if (record.newRecord && type === ABANDONED_CART_TYPE) {
    if (!(await eligibleForAbandonedCartWorkflows(seller))) {
      record.errors.add("base", "You must have at least one completed payout to create an abandoned cart workflow");
      return { ok: false, error: record.errors.fullMessages()[0]!, workflow: record };
    }
    refuse("the default abandoned cart email (DefaultAbandonedCartWorkflowGeneratorService)");
  }

  const neverPublished = record.get("first_published_at") === null;
  if (neverPublished) {
    if (type === VARIANT_TYPE) refuse("a variant workflow (BaseVariant lookup)");
    record.set("workflow_type", typeof type === "string" ? type : type === undefined || type === null ? null : refuse("a workflow type that is not text"));
    record.set("base_variant_id", null);
    record.set("link_id", productOrVariant ? Number(product!.id) : null);
    record.set("flags", WorkflowFlags.set(record.get("flags"), "send_to_past_customers", TRUE_VALUES.includes(params.send_to_past_customers as never)));
    // `workflow.abandoned_cart_type?`-style predicates read `attributes`, which materializes every attribute in column order.
    record.materializeAll();
    record.untracked(() => addAndValidateFilters(record, params, seller.timezone ?? "Pacific Time (US & Canada)", { typeColumn: "workflow_type", currency: seller.currency_type ?? "usd" }));
    if (!record.errors.isEmpty()) return { ok: false, error: record.errors.fullMessages()[0]!, workflow: record };
  }

  let error: string | null = null;
  try {
    await transaction(async () => {
      const wasJustCreated = record.newRecord;
      await Workflows.saveBang(record, { now });

      // `abandoned_cart_type?` reads `attributes`
      record.materializeAll();
      const abandoned = record.get("workflow_type") === ABANDONED_CART_TYPE;
      if (abandoned) {
        const rows = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("installments")} WHERE ${aliveInstallments(record, Prisma.sql`${column("installments", "installment_type")} = ${ABANDONED_CART_TYPE}`)} LIMIT 1`,
        );
        if (wasJustCreated || rows.length === 0) refuse("the default abandoned cart email (DefaultAbandonedCartWorkflowGeneratorService)");
      }

      if (!wasJustCreated && !abandoned) {
        await findInBatches<Installment>("installments", aliveInstallments(record, Prisma.sql`${column("installments", "installment_type")} = ${ABANDONED_CART_TYPE}`), BATCH_SIZE, async (rows) => {
          for (const row of rows) await markInstallmentDeletedBang(installmentOf(row), { now });
        });
      }

      if (neverPublished) {
        const sendToPast = WorkflowFlags.isSet(record.get("flags"), "send_to_past_customers");
        await findInBatches<Installment>("installments", aliveInstallments(record), BATCH_SIZE, async (rows) => {
          for (const row of rows) {
            const installment = installmentOf(row);
            installment.set("installment_type", record.get("workflow_type"));
            installment.set("json_data", record.get("json_data") ?? JSON.stringify(jsonData(record)));
            installment.set("seller_id", record.get("seller_id"));
            installment.set("link_id", record.get("link_id"));
            installment.set("base_variant_id", record.get("base_variant_id"));
            // is_for_new_customers_of_workflow
            installment.set("flags", Number(installmentFlags(installment.get("flags"), !sendToPast)));
            await Installments.saveBang(installment, { now });
          }
        });
      }

      if (!wasJustCreated) {
        if (params.save_action_name === SAVE_AND_PUBLISH_ACTION) await publishBang(record, { now, ...(options.uuid ? { uuid: options.uuid } : {}) });
        if (params.save_action_name === SAVE_AND_UNPUBLISH_ACTION) await unpublishBang(record, { now });
      }
    });
  } catch (caught) {
    if (caught instanceof RecordInvalid) error = caught.errors.fullMessages()[0] ?? null;
    else if (caught instanceof InstallmentInvalid) {
      record.errors.add("base", caught.message);
      error = record.errors.fullMessages()[0]!;
    } else throw caught;
  }
  return { ok: error === null, error, workflow: record };
}

const installmentFlags = (flags: number, enabled: boolean) => InstallmentFlags.set(flags, "is_for_new_customers_of_workflow", enabled);

// WorkflowsController#fetch_product_and_enforce_ownership: `current_seller.products.visible` by unique, then by custom permalink.
export async function findVisibleProduct(seller: User, permalink: unknown): Promise<Link | null> {
  if (typeof permalink !== "string" && permalink !== null && permalink !== undefined) return refuse("a permalink that is not text");
  for (const name of ["unique_permalink", "custom_permalink"]) {
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("\`links\`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", name)} ${permalink === null || permalink === undefined ? Prisma.sql`IS NULL` : Prisma.sql`= ${permalink}`} LIMIT 1`,
    );
    if (row) return castRow<Link>("Link", row);
  }
  return null;
}
