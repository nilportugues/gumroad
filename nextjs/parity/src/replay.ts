import { NextRequest } from "next/server";

import { diff } from "./canonical";
import { canonicalJob, canonicalMail, type JobsChannel, type MailChannel } from "./channels";
import { type CompareOptions, compareExchange, type Difference, formatDifferences } from "./compare";
import { dump, nonEmptyTables, readSchema, seedDatabase, type SqlExecutor } from "./db";
import { type CapturedExchange, type Exchange, type Fixture, type FixtureRequest, loadFixture, type RedisEntry } from "./fixture";
import { buildRequest, captureResponse, interceptFetch } from "./http";

export type Transport = (request: Request) => Promise<Response>;

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string | string[]>> }) => Response | Promise<Response>;
type RouteModule = Partial<Record<"GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", RouteHandler>>;

// Calls an App Router route module in-process, the way Next.js would. Handlers that read
// `cookies()` or `headers()` from next/headers need Next's request scope: use httpTransport.
export function routeHandlers(module: RouteModule, params: Record<string, string | string[]> = {}): Transport {
  return async (request) => {
    const handler = module[request.method as keyof RouteModule];
    if (!handler) return new Response(null, { status: 405 });
    return handler(new NextRequest(request), { params: Promise.resolve(params) });
  };
}

// Sends the request to a running Next.js server. Outbound HTTP then happens in that process,
// out of the replayer's reach: pass `interceptHttp: false` and ignore the "http" channel.
export function httpTransport(baseUrl: string): Transport {
  const realFetch = globalThis.fetch;
  return async (request) => {
    const source = new URL(request.url);
    const target = new URL(`${source.pathname}${source.search}`, baseUrl);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", source.host);
    const body = request.body ? await request.arrayBuffer() : undefined;
    return realFetch(target, { method: request.method, headers, body, redirect: "manual" });
  };
}

// Puts the recorded main Redis database back before a request. Pass the connection of a database
// the replay owns: it is flushed.
export interface RedisSeeder {
  reset(entries: Record<string, RedisEntry>): Promise<void>;
}

export type ReplayOptions = {
  sql: SqlExecutor;
  redis?: RedisSeeder;
  // Adjusts the recorded request before it is sent, e.g. to re-encrypt its cookies.
  rewriteRequest?: (request: FixtureRequest, fixture: Fixture, now: Date) => FixtureRequest;
  transport: Transport;
  jobs?: JobsChannel;
  mails?: MailChannel;
  interceptHttp?: boolean;
};

export async function replayExchange(exchange: Exchange, options: ReplayOptions, fixture?: Fixture): Promise<CapturedExchange> {
  const { sql, transport, jobs, mails, redis, interceptHttp = true } = options;
  // Tokens like "<now-48h>" are resolved against this instant, and the port's writes are
  // normalised against it, as the recorder did with the moment its request started.
  const now = new Date();
  await seedDatabase(sql, exchange.seed, now);
  await redis?.reset(exchange.redis ?? {});
  const schema = await readSchema(sql);
  const before = await dump(sql, schema, await nonEmptyTables(sql, schema));
  await jobs?.reset();
  await mails?.reset();

  const interceptor = interceptHttp ? interceptFetch(exchange.http, now) : undefined;
  let response: Response;
  try {
    const request = options.rewriteRequest && fixture ? options.rewriteRequest(exchange.request, fixture, now) : exchange.request;
    response = await transport(buildRequest(request));
  } finally {
    interceptor?.restore();
  }
  const captured = await captureResponse(response, now);

  const after = await dump(sql, schema, new Set([...Object.keys(before), ...(await nonEmptyTables(sql, schema))]));
  return {
    response: captured,
    db: diff(before, after, now),
    jobs: ((await jobs?.drain()) ?? []).map((job) => canonicalJob(job, now)),
    mails: ((await mails?.drain()) ?? []).map((mail) => canonicalMail(mail, now)),
    http: interceptor?.calls() ?? [],
  };
}

export type ExchangeResult = { expected: Exchange; actual: CapturedExchange; differences: Difference[] };
export type ReplayResult = { fixture: Fixture; exchanges: ExchangeResult[] };

// Each exchange is seeded from its own recorded state, so a mismatch in one does not cascade.
export async function replayFixture(
  fixture: Fixture | string,
  options: ReplayOptions & { compare?: CompareOptions },
): Promise<ReplayResult> {
  const loaded = typeof fixture === "string" ? loadFixture(fixture) : fixture;
  const exchanges: ExchangeResult[] = [];
  for (const expected of loaded.exchanges) {
    const actual = await replayExchange(expected, options, loaded);
    const compareOptions = { ...options.compare, ...(loaded.sessionCookie ? { sessionCookie: loaded.sessionCookie } : {}) };
    exchanges.push({ expected, actual, differences: compareExchange(expected, actual, compareOptions) });
  }
  return { fixture: loaded, exchanges };
}

// Replays one exchange of a fixture, for fixtures that record setup requests (a login) before the
// request under test.
export async function replayFixtureExchange(
  fixture: Fixture | string,
  index: number,
  options: ReplayOptions & { compare?: CompareOptions },
): Promise<ReplayResult> {
  const loaded = typeof fixture === "string" ? loadFixture(fixture) : fixture;
  const expected = loaded.exchanges.at(index);
  if (!expected) throw new Error(`${loaded.spec}: ${loaded.example} has no exchange ${index}`);
  const actual = await replayExchange(expected, options, loaded);
  const compareOptions = { ...options.compare, ...(loaded.sessionCookie ? { sessionCookie: loaded.sessionCookie } : {}) };
  return { fixture: loaded, exchanges: [{ expected, actual, differences: compareExchange(expected, actual, compareOptions) }] };
}

export function formatReplay(result: ReplayResult): string {
  const header = `${result.fixture.spec}: ${result.fixture.example}`;
  const body = result.exchanges
    .map(({ expected, differences }, i) => {
      const title = `  #${i + 1} ${expected.request.method} ${expected.request.path}`;
      if (differences.length === 0) return `${title}  identical`;
      return `${title}  ${differences.length} difference(s)\n${indent(formatDifferences(differences), 4)}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function assertParity(result: ReplayResult): void {
  if (result.exchanges.some(({ differences }) => differences.length > 0)) throw new Error(formatReplay(result));
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}
