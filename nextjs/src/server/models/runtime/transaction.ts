// Port of ActiveRecord::Transactions (activerecord 8.1) as configured in config/application.rb:
// nested calls join the outermost transaction, after_commit runs once it commits, and
// after_rollback runs if it rolls back.
import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma } from "@prisma/client";

import { noteRollback, queryCacheClient } from "./query-cache.ts";

export type Tx = Prisma.TransactionClient;
// `isolation` is `transaction(isolation: :read_committed)`; a runner that cannot honour it may ignore it.
export type TransactionOptions = { isolation?: "read_committed" };
export type TransactionRunner = <T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions) => Promise<T>;
export type Action = "create" | "update" | "destroy";

export type Participant = {
  // Set once the row was written; Rails' trigger_transactional_callbacks?.
  triggered: boolean;
  // run_commit_callbacks_on_first_saved_instances_in_transaction = true: a record instance
  // gets its commit callbacks once, with the action it had when first saved here.
  firstAction: Action;
  destroyed: boolean;
  // The record's class and id, for records that more than one instance of saves in the transaction: Rails runs before_commit
  // on the last instance saved and after_commit on the first (run_commit_callbacks_on_first_saved_instances_in_transaction).
  identity?: () => string;
  // before_commit callbacks.
  prepare?: (action: Action) => Promise<void>;
  commit: (action: Action) => Promise<void>;
  rollback: (action: Action) => Promise<void>;
  restore: () => void;
};

type State = { tx: Tx; participants: Map<object, Participant> };

const storage = new AsyncLocalStorage<State>();

// ActiveRecord never aborts a running transaction, so Prisma's 5s default would roll back work
// Rails completes. maxWait mirrors the pool's checkout_timeout (5s, unset in database.yml).
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 2_147_483_647 };

let runner: TransactionRunner = async (fn, options = {}) => {
  const { db } = await import("../../../lib/db.ts");
  const isolationLevel =
    options.isolation === "read_committed" ? Prisma.TransactionIsolationLevel.ReadCommitted : undefined;
  return db.$transaction(fn, { ...TRANSACTION_OPTIONS, ...(isolationLevel ? { isolationLevel } : {}) });
};

// Tests swap in a fake client; production uses the shared PrismaClient.
export function setTransactionRunner(next: TransactionRunner): void {
  runner = next;
}

export function currentTransaction(): Tx | null {
  return storage.getStore()?.tx ?? null;
}

class RollbackSignal extends Error {}

// `returningStatus` mirrors with_transaction_returning_status: a `false` result rolls back the
// outermost transaction, but inside a joined one it is only returned (ActiveRecord::Rollback is
// swallowed by nested transactions without requires_new).
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { returningStatus?: boolean; isolation?: "read_committed" } = {},
): Promise<T> {
  const current = storage.getStore();
  if (current) return fn(current.tx);

  const participants = new Map<object, Participant>();
  let result!: T;
  let rolledBack = false;
  // ActiveRecord begins lazily, so a transaction that sent nothing has nothing to roll back.
  let materialized = false;
  try {
    await runner(
      async (rawTx) => {
        const tx = queryCacheClient(rawTx, () => {
          materialized = true;
        });
        return storage.run({ tx, participants }, async () => {
          result = await fn(tx);
          if (options.returningStatus && (result as unknown) === false) throw new RollbackSignal();
        });
      },
      { isolation: options.isolation },
    );
  } catch (error) {
    rolledBack = true;
    if (materialized) noteRollback();
    for (const p of participants.values()) p.restore();
    for (const p of participants.values()) await p.rollback(p.destroyed ? "destroy" : p.firstAction);
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (rolledBack) return result;
  // Outside the store, so writes made by after_commit callbacks open their own transaction.
  const lastSaved = new Map<string, Participant>();
  for (const p of participants.values()) if (p.identity) lastSaved.set(p.identity(), p);
  for (const p of participants.values()) {
    if (p.prepare && (!p.identity || lastSaved.get(p.identity()) === p))
      await p.prepare(p.destroyed ? "destroy" : p.firstAction);
  }
  const committed = new Set<string>();
  for (const p of participants.values()) {
    if (!p.triggered) continue;
    if (p.identity) {
      const identity = p.identity();
      if (committed.has(identity)) continue;
      committed.add(identity);
    }
    await p.commit(p.destroyed ? "destroy" : p.firstAction);
  }
  return result;
}

export function participate(
  record: object,
  action: Action,
  make: () => Omit<Participant, "firstAction" | "destroyed" | "triggered">,
): Participant {
  const state = storage.getStore();
  if (!state) throw new Error("participate() called outside transaction()");
  let p = state.participants.get(record);
  if (!p) {
    p = { firstAction: action, destroyed: false, triggered: false, ...make() };
    state.participants.set(record, p);
  }
  return p;
}
