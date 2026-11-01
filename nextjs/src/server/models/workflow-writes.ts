// Writes of a Workflow (app/models/workflow.rb): `publish!`, `unpublish!` and `mark_deleted!`, with the emails they publish,
// unpublish and delete one by one (each email's rule advances its version first). Golden:
// worker/jobs/__fixtures__/workflow-writes.golden.json (scripts/golden/workflow-writes.rb).
//
// What Node cannot prove throws NotPortedError before the first write of the transaction, like the Installment writes
// it calls (installment-writes.ts): an email with files, a call to action, a message the sanitizer would judge, an audience
// filter that asks DynamoDB, a seller content moderation would review.
import { randomUUID } from "node:crypto";

import { Prisma, type Installment, type InstallmentRule, type User, type Workflow } from "@prisma/client";

import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { loadBelongsTo, type BelongsTo, validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { InstallmentRules, advanceVersionBang, markDeletedBang as markRuleDeletedBang } from "./installment-rule-writes.ts";
import { Installments, markDeletedBang as markInstallmentDeletedBang, post, publishBang as publishInstallmentBang, unpublishBang as unpublishInstallmentBang } from "./installment-writes.ts";
import { nilReceiver } from "./offer-code.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { currentTransaction, transaction } from "./runtime/transaction.ts";
import { column, findInBatches, selectRows, table } from "./sql.ts";
import { eligibleToSendEmails, MINIMUM_SALES_CENTS_VALUE } from "./user-email-eligibility.ts";
import { enqueueBang } from "./workflow-installment-schedule-writes.ts";

export type WorkflowRecord = ModelRecord<Workflow>;

const SECOND_MS = 1000;
const BATCH_SIZE = 1000;
const ABANDONED_CART_TYPE = "abandoned_cart";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const paperTrail = hasPaperTrail<Workflow>("Workflow", { itemType: "Workflow" });

export const Workflows = defineModel<Workflow>({
  rubyClass: "Workflow",
  prismaModel: "Workflow",
  delegate: (tx) => tx.workflow as never,
  validations: [validatesAssociationPresence<Workflow>(SELLER)],
  beforeSave: [mergeJsonDataWithCurrentRow<Workflow>("workflows")],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
});

// What the writes take from the outside: the clock for the intents and SecureRandom.uuid.
export type WorkflowWriteDeps = { now: () => Date; uuid: () => string; logError: (message: string) => void };
const defaultDeps = (): WorkflowWriteDeps => ({ now: () => new Date(), uuid: () => randomUUID(), logError: (message) => console.error(message) });

// `workflow.seller`, loaded once per instance
async function sellerOf(workflow: WorkflowRecord): Promise<User | null> {
  const tx = currentTransaction();
  if (tx === null) throw new Error("Workflow#seller is read inside the transition lock");
  return (await loadBelongsTo(workflow, SELLER, { tx })) as User | null;
}

// `self.class.transaction { save! if has_changes_to_save?; lock!; yield }`
function withTransitionLock<T>(workflow: WorkflowRecord, options: SaveOptions, fn: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    if (workflow.hasChangesToSave()) await Workflows.saveBang(workflow, options);
    await Workflows.lockBang(workflow);
    return fn();
  });
}

const alive = (workflow: WorkflowRecord) => Prisma.sql`${column("installments", "workflow_id")} = ${workflow.get("id")} AND ${column("installments", "deleted_at")} IS NULL`;

// A row of `workflow.installments`: the has_many sets the inverse `workflow` on each, which reads its foreign key.
export function installmentOf(row: Installment): ModelRecord<Installment> {
  const installment = Installments.load(row);
  installment.touch("workflow_id");
  return installment;
}

// `installment.installment_rule`, as a record
async function ruleOf(installment: ModelRecord<Installment>) {
  const row = await post(installment).installmentRule();
  return row === null ? null : InstallmentRules.load(row as InstallmentRule);
}

// `Money.from_cents(Installment::MINIMUM_SALES_CENTS_VALUE).format(no_cents: true)`
const minimumSales = () => `$${MINIMUM_SALES_CENTS_VALUE / 100}`;

// `publish!`
export async function publishBang(workflow: WorkflowRecord, options: SaveOptions & Partial<WorkflowWriteDeps> = {}): Promise<boolean> {
  const deps = { ...defaultDeps(), ...options };
  const now = options.now ?? deps.now;
  return withTransitionLock(workflow, { now }, async () => {
    if (workflow.untracked(() => workflow.get("published_at")) !== null) return true;

    // `abandoned_cart_type?` reads `attributes`, which materializes every attribute in column order
    workflow.materializeAll();
    if (workflow.get("workflow_type") !== ABANDONED_CART_TYPE) {
      const seller = await sellerOf(workflow);
      if (seller === null) throw nilReceiver("eligible_to_send_emails?");
      if (!(await eligibleToSendEmails(seller))) {
        workflow.errors.add("base", `You cannot publish a workflow until you have made at least ${minimumSales()} in total earnings and received a payout`);
        throw new RecordInvalid(workflow.errors);
      }
    }

    // `DateTime.current.change(usec: 0)`
    const publishedAt = new Date(Math.floor(now().getTime() / SECOND_MS) * SECOND_MS);
    workflow.set("published_at", publishedAt);
    if (workflow.get("first_published_at") === null) workflow.set("first_published_at", publishedAt);
    const toSchedule: [number, number][] = [];
    await findInBatches<Installment>("installments", alive(workflow), BATCH_SIZE, async (rows) => {
      for (const row of rows) {
        const installment = installmentOf(row);
        const rule = await ruleOf(installment);
        if (rule !== null) await advanceVersionBang(rule, { now });
        await publishInstallmentBang(installment, { publishedAt, now });
        if (rule !== null && row.installment_type !== ABANDONED_CART_TYPE) toSchedule.push([row.id, rule.get("version")]);
      }
    });
    await Workflows.saveBang(workflow, { now });
    for (const [installmentId, ruleVersion] of toSchedule) {
      await enqueueBang({ installmentId, ruleVersion, oldDelayedDeliveryTime: null, cutoffReferenceTime: publishedAt, expectedPublishedAt: publishedAt }, deps);
    }
    return true;
  });
}

// `unpublish!`
export async function unpublishBang(workflow: WorkflowRecord, options: SaveOptions = {}): Promise<boolean> {
  const now = options.now ?? (() => new Date());
  return withTransitionLock(workflow, { now }, async () => {
    if (workflow.get("published_at") === null) return true;

    workflow.set("published_at", null);
    await findInBatches<Installment>("installments", alive(workflow), BATCH_SIZE, async (rows) => {
      for (const row of rows) {
        const installment = installmentOf(row);
        const rule = await ruleOf(installment);
        if (rule !== null) await advanceVersionBang(rule, { now });
        await unpublishInstallmentBang(installment, { now });
      }
    });
    await Workflows.saveBang(workflow, { now });
    return true;
  });
}

// `mark_deleted!`
export async function markDeletedBang(workflow: WorkflowRecord, options: SaveOptions = {}): Promise<boolean> {
  const now = options.now ?? (() => new Date());
  return transaction(async () => {
    await Workflows.lockBang(workflow);
    // Time.current, cut to the column's whole seconds
    workflow.set("deleted_at", new Date(Math.floor(now().getTime() / SECOND_MS) * SECOND_MS));
    const rows = await selectRows<Installment>(Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "workflow_id")} = ${workflow.get("id")}`);
    for (const row of rows) {
      const installment = installmentOf(row);
      const rule = await ruleOf(installment);
      if (rule !== null) await advanceVersionBang(rule, { now });
      await markInstallmentDeletedBang(installment, { now });
      if (rule !== null) await markRuleDeletedBang(rule, { now });
    }
    await Workflows.saveBang(workflow, { now });
    return true;
  });
}
