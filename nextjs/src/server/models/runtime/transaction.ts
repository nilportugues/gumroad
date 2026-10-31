// Port of ActiveRecord::Transactions (activerecord 8.1) as configured in config/application.rb:
// nested calls join the outermost transaction, after_commit runs once it commits, and
// after_rollback runs if it rolls back.
import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma } from "@prisma/client";

export type Tx = Prisma.TransactionClient;
export type TransactionRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
export type Action = "create" | "update" | "destroy";

export type Participant = {
  // Set once the row was written; Rails' trigger_transactional_callbacks?.
  triggered: boolean;
  // run_commit_callbacks_on_first_saved_instances_in_transaction = true: a record instance
  // gets its commit callbacks once, with the action it had when first saved here.
  firstAction: Action;
  destroyed: boolean;
  commit: (action: Action) => Promise<void>;
  rollback: (action: Action) => Promise<void>;
  restore: () => void;
};

type State = { tx: Tx; participants: Map<object, Participant> };

const storage = new AsyncLocalStorage<State>();

// ActiveRecord never aborts a running transaction, so Prisma's 5s default would roll back work
// Rails completes. maxWait mirrors the pool's checkout_timeout (5s, unset in database.yml).
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 2_147_483_647 };

let runner: TransactionRunner = async (fn) => {
  const { db } = await import("../../../lib/db.ts");
  return db.$transaction(fn, TRANSACTION_OPTIONS);
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
export async function transaction<T>(fn: (tx: Tx) => Promise<T>, options: { returningStatus?: boolean } = {}): Promise<T> {
  const current = storage.getStore();
  if (current) return fn(current.tx);

  const participants = new Map<object, Participant>();
  let result!: T;
  let rolledBack = false;
  try {
    await runner(async (tx) =>
      storage.run({ tx, participants }, async () => {
        result = await fn(tx);
        if (options.returningStatus && (result as unknown) === false) throw new RollbackSignal();
      }),
    );
  } catch (error) {
    rolledBack = true;
    for (const p of participants.values()) p.restore();
    for (const p of participants.values()) await p.rollback(p.destroyed ? "destroy" : p.firstAction);
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (rolledBack) return result;
  // Outside the store, so writes made by after_commit callbacks open their own transaction.
  for (const p of participants.values()) {
    if (p.triggered) await p.commit(p.destroyed ? "destroy" : p.firstAction);
  }
  return result;
}

export function participate(record: object, action: Action, make: () => Omit<Participant, "firstAction" | "destroyed" | "triggered">): Participant {
  const state = storage.getStore();
  if (!state) throw new Error("participate() called outside transaction()");
  let p = state.participants.get(record);
  if (!p) {
    p = { firstAction: action, destroyed: false, triggered: false, ...make() };
    state.participants.set(record, p);
  }
  return p;
}
