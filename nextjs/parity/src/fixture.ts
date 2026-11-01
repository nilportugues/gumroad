import { readFileSync } from "node:fs";

import { type Json, parseJson, type TableDiff } from "./canonical";

// Shape written by spec/support/parity/recorder.rb. Bump FORMAT_VERSION on both sides together.
export const FORMAT_VERSION = 1;

export type FixtureRequest = {
  source: "request" | "controller";
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  cookies?: Record<string, string>;
  remoteIp?: string;
  body?: string;
  bodyBase64?: string;
};

export type CapturedResponse = {
  status: number;
  location?: string;
  headers: Record<string, Json>;
  cookies?: Record<string, Record<string, Json>>;
  json?: Json;
  inertia?: Json;
  body?: string;
  bodyBase64?: string;
};

export type CapturedJob = {
  class: string;
  args: Json;
  queue?: string;
  at?: string;
  activeJob?: boolean;
};

export type CapturedMail = {
  mailer?: string;
  from?: Json;
  to?: Json;
  cc?: Json;
  bcc?: Json;
  replyTo?: Json;
  subject?: string;
  text?: string;
  html?: string;
};

export type CapturedHttp = {
  method: string;
  url: string;
  contentType?: string;
  body?: string;
  // Served back to the port during replay; not compared.
  response: { status?: number; contentType?: string; body?: string };
};

export type SeedTable = {
  columns: Record<string, string>;
  primaryKey: string[];
  rows: Record<string, Json>[];
};

// A key of the main Redis database as the recorder saw it before the request.
export type RedisEntry = { type: "string" | "hash" | "set"; value: string | Record<string, string> | string[]; ttl?: number };

export type Seed = {
  tables: Record<string, SeedTable>;
  autoIncrement: Record<string, number>;
};

export type CapturedExchange = {
  response: CapturedResponse;
  db: Record<string, TableDiff>;
  jobs: CapturedJob[];
  mails: CapturedMail[];
  http: CapturedHttp[];
};

export type Exchange = CapturedExchange & { seed: Seed; request: FixtureRequest; redis?: Record<string, RedisEntry> };

export type Fixture = {
  version: number;
  spec: string;
  example: string;
  sessionCookie?: string;
  recordedOn?: string;
  // The recording Rails app's secret_key_base (test only), to re-encrypt recorded cookies.
  secretKeyBase?: string;
  exchanges: Exchange[];
};

export function loadFixture(path: string): Fixture {
  const fixture = parseJson(readFileSync(path, "utf8")) as unknown as Fixture;
  if (fixture.version !== FORMAT_VERSION) {
    throw new Error(`${path} is fixture format ${fixture.version}; this replayer reads ${FORMAT_VERSION}. Re-record it.`);
  }
  return fixture;
}
