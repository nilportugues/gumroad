import { createServer, type Server } from "node:http";

import type { PrismaClient } from "@prisma/client";

import { dump, nonEmptyTables, readSchema, type SqlExecutor } from "./db";
import type { CapturedHttp, Exchange, TimelineEvent } from "./fixture";
import { keptHttpHeaders } from "./http";

// A stand-in for the payment processor (Stripe, PayPal) a port reaches through `outboundFetch` when OUTBOUND_HTTP_STAND_IN is set.
// It answers the calls the fixture recorded, and notes for each call that arrived which tables had been written since the
// previous one, so a replay can prove what Rails' timeline proves: the order of the writes against the calls (nothing written
// before a refund reaches Stripe, the ledger written after) and the headers each call carried (the idempotency key).

// What `outboundFetch` (src/server/infra/outbound-http.ts) sends the real URL in.
const PARITY_ORIGINAL_URL_HEADER = "x-parity-original-url";

export type StandInCall = {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
  // Tables whose rows changed between the previous call (or the request's start) and this one.
  writtenBefore: string[];
};

export type StandIn = {
  // Where to point OUTBOUND_HTTP_STAND_IN.
  url: string;
  // Starts a request: serves these recorded answers, forgets the previous request's calls.
  arm(recorded: CapturedHttp[]): void;
  // Takes the baseline writes are measured against: the database as the request found it.
  baseline(): Promise<void>;
  // After the response: the calls Node made, and the tables written after the last of them.
  finish(): Promise<{ calls: StandInCall[]; writtenAfter: string[] }>;
  close(): Promise<void>;
};

// A connection that sees rows another connection has written but not committed: Rails writes inside transactions, and the
// question is which write came first, not whether it has committed.
export function uncommittedReader(client: PrismaClient): SqlExecutor {
  const run = <T>(fn: (tx: PrismaClient) => Promise<T>) =>
    client.$transaction((tx) => fn(tx as unknown as PrismaClient), {
      isolationLevel: "ReadUncommitted",
      timeout: 60_000,
    });
  const reader: SqlExecutor = {
    query: (sql, params = []) => run((tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params)),
    execute: async (sql, params = []) => {
      await run((tx) => tx.$executeRawUnsafe(sql, ...params));
    },
    pinned: (fn) => fn(reader),
  };
  return reader;
}

type Fingerprints = Map<string, string>;

async function fingerprints(sql: SqlExecutor): Promise<Fingerprints> {
  const schema = await readSchema(sql);
  const tables = await dump(sql, schema, await nonEmptyTables(sql, schema));
  return new Map(Object.entries(tables).map(([table, { rows }]) => [table, JSON.stringify(rows)]));
}

function changedTables(before: Fingerprints, after: Fingerprints): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((table) => before.get(table) !== after.get(table))
    .sort();
}

export async function startStandIn(reader: SqlExecutor): Promise<StandIn> {
  let unused: CapturedHttp[] = [];
  let calls: StandInCall[] = [];
  let last: Fingerprints = new Map();
  // Calls are handled one at a time: each needs the database as it stood when it arrived.
  let queue: Promise<unknown> = Promise.resolve();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      queue = queue.then(async () => {
        const url = String(request.headers[PARITY_ORIGINAL_URL_HEADER] ?? request.url);
        const method = request.method ?? "";
        const now = await fingerprints(reader);
        const call: StandInCall = {
          method,
          url,
          headers: keptHttpHeaders(
            Object.fromEntries(
              Object.entries(request.headers).map(([name, value]) => [name, [value].flat().join(", ")]),
            ),
          ),
          writtenBefore: changedTables(last, now),
        };
        const body = Buffer.concat(chunks).toString("utf8");
        if (body) call.body = body;
        last = now;
        calls.push(call);
        const index = unused.findIndex((candidate) => candidate.method === method && candidate.url === url);
        if (index === -1) return void response.writeHead(599).end(`parity: no recorded answer for ${method} ${url}`);
        const [answer] = unused.splice(index, 1);
        // A recorded dropped connection: no status line, no body, as when the peer resets the socket.
        if (answer!.response.dropped) return void request.socket.destroy();
        response.writeHead(
          answer!.response.status ?? 200,
          answer!.response.contentType ? { "content-type": answer!.response.contentType } : {},
        );
        response.end(answer!.response.body ?? "");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    arm: (recorded) => {
      unused = [...recorded];
      calls = [];
    },
    baseline: async () => {
      last = await fingerprints(reader);
    },
    finish: async () => {
      await queue;
      return { calls: [...calls], writtenAfter: changedTables(last, await fingerprints(reader)) };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The tables written before each outbound call, then after the last, in the order Rails took them: `segments[i]` is what was
// written between call i-1 and call i, and the final entry what followed the last call. Jobs are not segments.
export function timelineSegments(timeline: TimelineEvent[]): string[][] {
  const segments: Set<string>[] = [new Set()];
  for (const event of timeline) {
    if (event.type === "http") segments.push(new Set());
    else if (event.type === "db") segments.at(-1)!.add(event.table);
  }
  return segments.map((tables) => [...tables].sort());
}

export type StandInExpectation = {
  // The recorded request headers must match, the credential digest included: only when the replay runs with the recording's key.
  compareAuthorization?: boolean;
  // Tables a port may write that Rails did not at that point (a cache table the port keeps).
  ignoreTables?: string[];
};

// Differences between what Rails did (the fixture's `http` and `timeline`) and what the port did against the stand-in.
export function standInDifferences(
  exchange: Exchange,
  actual: { calls: StandInCall[]; writtenAfter: string[] },
  options: StandInExpectation = {},
): string[] {
  const differences: string[] = [];
  const ignore = new Set(options.ignoreTables ?? []);
  const recorded = exchange.http;
  if (recorded.length !== actual.calls.length)
    differences.push(`calls: Rails made ${recorded.length}, Node made ${actual.calls.length}`);

  recorded.forEach((call, index) => {
    const got = actual.calls[index];
    if (!got)
      return void differences.push(`call ${index + 1}: Rails sent ${call.method} ${call.url}, Node sent nothing`);
    const label = `call ${index + 1} ${call.method} ${call.url}`;
    if (got.method !== call.method || decodeURIComponent(got.url) !== decodeURIComponent(call.url))
      differences.push(`${label}: Node sent ${got.method} ${got.url}`);
    if ((got.body ?? "") !== (call.body ?? ""))
      differences.push(`${label}: body\n    rails: ${call.body}\n    next:  ${got.body}`);
    const want = { ...call.headers };
    const have = { ...got.headers };
    if (!options.compareAuthorization) {
      if ("authorization" in want !== "authorization" in have)
        differences.push(`${label}: authorization present on one side only`);
      delete want.authorization;
      delete have.authorization;
    }
    if (JSON.stringify(sortKeys(want)) !== JSON.stringify(sortKeys(have)))
      differences.push(`${label}: headers\n    rails: ${JSON.stringify(want)}\n    next:  ${JSON.stringify(have)}`);
  });

  const expected = timelineSegments(exchange.timeline ?? []);
  const got = [...actual.calls.map((call) => call.writtenBefore), actual.writtenAfter];
  expected.forEach((tables, index) => {
    const want = tables.filter((table) => !ignore.has(table));
    const have = (got[index] ?? []).filter((table) => !ignore.has(table));
    if (want.join() !== have.join()) {
      const where = index === expected.length - 1 ? "after the last call" : `before call ${index + 1}`;
      differences.push(
        `writes ${where}\n    rails: ${want.join(", ") || "none"}\n    next:  ${have.join(", ") || "none"}`,
      );
    }
  });
  return differences;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}
