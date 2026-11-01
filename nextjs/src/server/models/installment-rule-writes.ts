// Writes of an InstallmentRule (app/models/installment_rule.rb): its validations, `advance_version!`, `mark_deleted!`
// and the callbacks around the version a workflow installment's rule carries in Redis (the pending-version Lua scripts
// before the save, promoted or cleared once the transaction ends). Golden: worker/jobs/__fixtures__/workflow-writes.golden.json.
import { randomUUID } from "node:crypto";

import type { Installment, InstallmentRule } from "@prisma/client";
import type { Redis } from "ioredis";

import { notifyError } from "../infra/error-reporting.ts";
import { getRedis } from "../infra/redis.ts";
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { deletable } from "./concerns/deletable.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { associationCache, loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { findById } from "./row-reads.ts";
import { defineModel, type Callback, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { participate } from "./runtime/transaction.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import {
  CACHE_COMMITTED_VERSION_SCRIPT,
  INSTALLMENT_RULE_VERSION_CACHE_TTL_SECONDS,
  rulePendingTokenKey,
  ruleVersionKey,
} from "./installment-rule.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";

export type InstallmentRuleRecord = ModelRecord<InstallmentRule>;

// InstallmentRule::PENDING_OWNER_CACHE_TTL (5 minutes) and PENDING_VERSION_CACHE_TTL (6 minutes)
const PENDING_OWNER_CACHE_TTL_SECONDS = 5 * 60;
const PENDING_VERSION_CACHE_TTL_SECONDS = PENDING_OWNER_CACHE_TTL_SECONDS + 60;
// InstallmentRule::MAX_DELAY_SECONDS and OVERFLOW_DELAY_MESSAGE
const MAX_DELAY_SECONDS = 2 ** 31 - 1;
const MAX_DELAY_YEARS = Math.trunc(MAX_DELAY_SECONDS / (365 * 24 * 3600));
const OVERFLOW_DELAY_MESSAGE = `Use a delay of ${MAX_DELAY_YEARS} years or less.`;

// InstallmentRule::CACHE_PENDING_VERSION_SCRIPT and CLEAR_PENDING_VERSION_SCRIPT, byte for byte
const CACHE_PENDING_VERSION_SCRIPT = `local current = redis.call("GET", KEYS[1])
if not current or tonumber(ARGV[1]) >= tonumber(current) then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[4])
  return tonumber(ARGV[1])
end
return tonumber(current)
`;
const CLEAR_PENDING_VERSION_SCRIPT = `if redis.call("GET", KEYS[2]) == ARGV[1] then
  return redis.call("DEL", KEYS[1], KEYS[2])
end
return 0
`;

// What the callbacks take from outside the model: the main Redis ($redis), SecureRandom.uuid and ErrorNotifier.
export type InstallmentRuleDeps = { redis: () => Redis; uuid: () => string; notify: (error: unknown, context: Record<string, unknown>) => void };
const defaultDeps: InstallmentRuleDeps = { redis: () => getRedis("main"), uuid: () => randomUUID(), notify: (error, context) => notifyError(error, context) };
let deps: InstallmentRuleDeps = defaultDeps;

// Tests swap in a scratch Redis and a sequential uuid; returns the restore function.
export function setInstallmentRuleDeps(overrides: Partial<InstallmentRuleDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

const INSTALLMENT_WORKFLOW = "installmentWorkflow";
const INSTALLMENT: BelongsTo = { name: "installment", foreignKey: "installment_id", targetTable: "installments", targetModel: "Installment" };

// The installment the validations loaded: callbacks that run after validation read it as `installment` does.
const loadedInstallment = (record: InstallmentRuleRecord): Installment | null => (associationCache(record).get("installment")?.row as Installment | null | undefined) ?? null;

// `workflow_rule?`: `installment&.workflow_id.present?`
const workflowRule = (record: InstallmentRuleRecord) => loadedInstallment(record)?.workflow_id != null;

const deliveryDateChanged = (record: InstallmentRuleRecord) => record.attributeChanged("delayed_delivery_time") || record.attributeChanged("to_be_published_at");

const paperTrail = hasPaperTrail<InstallmentRule>("InstallmentRule", { itemType: "InstallmentRule" });

async function cachePendingVersionBang(installmentId: number, version: number, token: string): Promise<number> {
  const result = await deps
    .redis()
    .eval(CACHE_PENDING_VERSION_SCRIPT, 2, ruleVersionKey(installmentId), rulePendingTokenKey(installmentId), String(version), token, String(PENDING_VERSION_CACHE_TTL_SECONDS), String(PENDING_OWNER_CACHE_TTL_SECONDS));
  return rubyToI(String(result));
}

// `InstallmentRule.promote_pending_version`: a Redis failure is reported and the commit goes on.
async function promotePendingVersion(installmentId: number, ruleId: number, version: number, token: string): Promise<void> {
  try {
    await deps.redis().eval(CACHE_COMMITTED_VERSION_SCRIPT, 2, ruleVersionKey(installmentId), rulePendingTokenKey(installmentId), String(version), token, String(INSTALLMENT_RULE_VERSION_CACHE_TTL_SECONDS));
  } catch (error) {
    deps.notify(error, { installment_rule_id: ruleId });
  }
}

async function clearPendingVersion(installmentId: number, ruleId: number, token: string): Promise<void> {
  try {
    await deps.redis().eval(CLEAR_PENDING_VERSION_SCRIPT, 2, ruleVersionKey(installmentId), rulePendingTokenKey(installmentId), token);
  } catch (error) {
    deps.notify(error, { installment_rule_id: ruleId });
  }
}

// AfterCommitEverywhere.after_rollback: once the outermost transaction rolls back.
function afterRollbackEverywhere(fn: () => Promise<unknown>): void {
  participate({}, "update", () => ({ commit: async () => {}, rollback: async () => void (await fn()), restore: () => {} }));
}

const validations: Callback<InstallmentRule>[] = [
  {
    // validates_presence_of :installment
    name: "validates_presence_of installment",
    async run(record, ctx) {
      if ((await loadBelongsTo(record, INSTALLMENT, ctx)) === null) record.errors.add("installment", "blank");
    },
  },
  validatesPresenceOf<InstallmentRule>(["version"]),
  {
    name: "to_be_published_at_cannot_be_in_the_past",
    run(record, ctx) {
      // Deleting a rule after its date passes is fine; reviving one must re-check the date.
      if (record.attributeChanged("deleted_at", { from: null })) return;
      const at = record.get("to_be_published_at");
      if (at === null) return;
      if (at.getTime() > (ctx.now ?? (() => new Date()))().getTime()) return;
      record.errors.add("base", "Please select a date and time in the future.");
    },
  },
  {
    name: "to_be_published_at_must_exist_for_non_workflow_posts",
    async run(record) {
      const installment = loadedInstallment(record);
      if (installment === null) return;
      // `installment.workflow` is loaded once per installment instance
      if (installment.workflow_id !== null) {
        const memo = (record.ivars[INSTALLMENT_WORKFLOW] ??= new Map()) as Map<number, Promise<unknown>>;
        if (!memo.has(installment.workflow_id)) memo.set(installment.workflow_id, findById("Workflow", installment.workflow_id));
        if ((await memo.get(installment.workflow_id)) !== null) return;
      }
      if (record.get("to_be_published_at") !== null) return;
      record.errors.add("base", "Please select a date and time in the future.");
    },
  },
  {
    name: "delayed_delivery_time_must_fit_the_column",
    run(record) {
      const delay = record.get("delayed_delivery_time");
      if (delay === null) return;
      if (delay < 0) record.errors.add("delayed_delivery_time", "must not be negative");
      else if (delay > MAX_DELAY_SECONDS) record.errors.add("base", OVERFLOW_DELAY_MESSAGE);
    },
  },
];

export const InstallmentRules = defineModel<InstallmentRule>({
  rubyClass: "InstallmentRule",
  prismaModel: "InstallmentRule",
  delegate: (tx) => tx.installmentRule as never,
  validations,
  beforeSave: [
    {
      // A version change invalidates jobs that use old delivery or publication state.
      name: "increment_version",
      if: deliveryDateChanged,
      run: (record) => record.set("version", record.get("version") + 1),
    },
    {
      // Publish before SQL so stale jobs cannot cross a transaction that changes delivery state.
      name: "cache_pending_version",
      if: (record) => workflowRule(record) && record.attributeChanged("version") && record.persisted,
      async run(record) {
        const token = deps.uuid();
        const installmentId = record.get("installment_id")!;
        const ruleId = record.get("id");
        const version = record.get("version");
        await afterCommitEverywhere(() => promotePendingVersion(installmentId, ruleId, version, token));
        afterRollbackEverywhere(() => clearPendingVersion(installmentId, ruleId, token));
        await cachePendingVersionBang(installmentId, version, token);
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  afterCommit: [
    {
      name: "cache_committed_version",
      if: workflowRule,
      async run(record) {
        const installmentId = record.get("installment_id");
        if (installmentId === null) return;
        try {
          await deps.redis().eval(CACHE_COMMITTED_VERSION_SCRIPT, 2, ruleVersionKey(installmentId), rulePendingTokenKey(installmentId), String(record.get("version")), "", String(INSTALLMENT_RULE_VERSION_CACHE_TTL_SECONDS));
        } catch (error) {
          deps.notify(error, { installment_rule_id: record.get("id") });
        }
      },
    },
  ],
});

const softDeletion = deletable(InstallmentRules);

// `with_lock { update!(version: version + 1) }`
export function advanceVersionBang(rule: InstallmentRuleRecord, options: SaveOptions = {}): Promise<void> {
  return InstallmentRules.withLock(rule, async () => {
    rule.set("version", rule.get("version") + 1);
    await InstallmentRules.saveBang(rule, options);
  });
}

// `mark_deleted!` (Deletable)
export const markDeletedBang = (rule: InstallmentRuleRecord, options: SaveOptions = {}) => softDeletion.markDeletedBang(rule, options);
