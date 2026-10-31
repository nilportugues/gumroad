// Replays model-jobs.golden.json (see generate-model-jobs-golden.rb) against a Node job: every
// statement the job sends, raw or through a model service, is rendered the way ActiveRecord's
// Mysql2Adapter writes it and answered with what the fake MySQL answered Rails at that step.
// The test then compares the two statement lists. There is no MySQL here: what this proves is
// that both sides send the same statements given the same answers.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";

import { quote, renderSql } from "../../../server/models/runtime/quoting.ts";
import { setSqlClient, type SqlClient } from "../../../server/models/sql.ts";
import { setTransactionRunner, type Tx } from "../../../server/models/runtime/transaction.ts";
import { parseRubyJson, type JsonValue } from "../../../server/jobs/sidekiq/ruby-json.ts";
import type { RedisSnapshot } from "./golden.ts";

type Value = JsonValue | { $time: string } | { $decimal: string };
export type StatementResult = { fields?: string[]; rows?: Value[][]; affected?: number; last_id?: number; error?: { number: number; message: string } };
export type Statement = { sql: string; result?: StatementResult };
export type ModelJobCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  namespace_writes: [string, string][];
};
export type ModelJobsGolden = {
  now: number;
  jobs: Record<string, ModelJobCase[]>;
  big_decimal_to_s: [string, string][];
  adult_keyword_detector: [string | null, boolean][];
};

export const modelJobsGolden = parseRubyJson(readFileSync(new URL("model-jobs.golden.json", import.meta.url), "utf8")) as unknown as ModelJobsGolden;
export const GOLDEN_NOW = new Date(Math.round(modelJobsGolden.now * 1000));
export const goldenNow = () => new Date(GOLDEN_NOW.getTime());

export { quote, renderSql };

function decode(value: Value): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("$time" in value) return new Date(value.$time as string);
    if ("$decimal" in value) return new Prisma.Decimal(value.$decimal as string);
  }
  return value;
}

function failure(error: { number: number; message: string }): Error {
  if (error.number === 1062) return new Prisma.PrismaClientKnownRequestError(error.message, { code: "P2002", clientVersion: Prisma.prismaVersion.client });
  return Object.assign(new Error(error.message), { errno: error.number });
}

const prismaModels = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name.charAt(0).toLowerCase() + m.name.slice(1), m]));

export function sqlReplay(golden: Statement[]) {
  const log: string[] = [];
  let index = 0;

  const next = (sql: string): StatementResult => {
    log.push(sql);
    const statement = golden[index++];
    const result = statement?.result ?? {};
    if (result.error) throw failure(result.error);
    return result;
  };
  const rows = (result: StatementResult) =>
    (result.rows ?? []).map((row) => Object.fromEntries((result.fields ?? []).map((field, i) => [field, decode(row[i]!)])));

  let begun: boolean | null = null;
  const touch = () => {
    if (begun === false) {
      begun = true;
      next("BEGIN");
    }
  };

  const client = (inTransaction: boolean) => {
    const raw: SqlClient = {
      $queryRaw: (async (sql: Prisma.Sql) => {
        if (inTransaction) touch();
        return rows(next(renderSql(sql)));
      }) as never,
      $executeRaw: (async (sql: Prisma.Sql) => {
        if (inTransaction) touch();
        return next(renderSql(sql)).affected ?? 0;
      }) as never,
    };
    return raw;
  };

  const delegate = (prop: string) => {
    const model = prismaModels.get(prop);
    if (!model) throw new Error(`no Prisma model for tx.${prop}`);
    const tableName = model.dbName ?? model.name;
    const columns = model.fields.filter((f) => f.kind === "scalar").map((f) => f.dbName ?? f.name);
    const q = (name: string) => `\`${name}\``;
    return {
      async create({ data }: { data: Record<string, unknown> }) {
        touch();
        const names = columns.filter((c) => c in data);
        const result = next(`INSERT INTO ${q(tableName)} (${names.map(q).join(", ")}) VALUES (${names.map((c) => quote(data[c])).join(", ")})`);
        return { ...data, id: data.id ?? BigInt(result.last_id ?? 0) };
      },
      async update({ where, data }: { where: { id: unknown }; data: Record<string, unknown> }) {
        touch();
        const sets = Object.keys(data).map((c) => `${q(tableName)}.${q(c)} = ${quote(data[c])}`);
        next(`UPDATE ${q(tableName)} SET ${sets.join(", ")} WHERE ${q(tableName)}.${q("id")} = ${quote(where.id)}`);
        return { ...data, id: where.id };
      },
      async delete({ where }: { where: { id: unknown } }) {
        touch();
        next(`DELETE FROM ${q(tableName)} WHERE ${q(tableName)}.${q("id")} = ${quote(where.id)}`);
        return { id: where.id };
      },
    };
  };

  const txClient = client(true);
  const tx = new Proxy({} as Tx, {
    get(_, prop: string) {
      if (prop === "$queryRaw") return txClient.$queryRaw;
      if (prop === "$executeRaw") return txClient.$executeRaw;
      if (prop === "then") return undefined;
      return delegate(prop);
    },
  });

  setSqlClient(() => client(false));
  setTransactionRunner(async (fn) => {
    begun = false;
    try {
      const result = await fn(tx);
      if (begun) next("COMMIT");
      return result;
    } catch (error) {
      if (begun) next("ROLLBACK");
      throw error;
    } finally {
      begun = null;
    }
  });

  return {
    log,
    // ReplicaLagWatcher.watch, as the generator logs it.
    watch: async () => {
      next("-- ReplicaLagWatcher.watch");
    },
    expected: golden.map((s) => s.sql),
  };
}
