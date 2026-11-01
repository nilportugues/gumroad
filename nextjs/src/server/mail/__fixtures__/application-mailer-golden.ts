// Loads application-mailer.golden.json (generate-application-mailer-golden.rb) and recreates the
// environment it was recorded in: production, its SMTP secrets, the built email stylesheet, and
// its pinned Kernel.rand values and AES IVs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setCredentialsForTesting } from "../../infra/config.ts";
import type { JsonValue } from "../../jobs/sidekiq/ruby-json.ts";
import type { MimeIdentity } from "../mime.ts";
import type { RouterDeps } from "../mailer-info.ts";
import type { Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";

export type Delivered = {
  settings: { address: string; port: number; domain: string; user_name: string; password: string; authentication: string; enable_starttls_auto: boolean };
  encoded: string;
  envelope_from: string;
  envelope_to: string[];
};

export type MessageCase = {
  name: string;
  mailer: string;
  method: string;
  job_args: JsonValue[];
  statements: Statement[];
  features: string[];
  redis_before: Record<string, string>;
  rands_used: number[];
  ivs: string[];
  rendered_html: string | null;
  returned_message: boolean;
  delivered: Delivered[];
  redis_after: Record<string, string>;
  // EmailRouterFallbackService keys: [value, ttl].
  fallback_after: Record<string, [string, number]>;
};

export type JobCase = { name: string; args: JsonValue[]; error: { class: string; message: string } | null; statements: Statement[]; delivered: Delivered[] };

type HeaderCase = { mailer_class: string; mailer_method: string; args: string; headers: Record<string, string>; ivs?: string[]; decrypted?: Record<string, string> };

export type Golden = {
  now: string;
  secrets: Record<string, string>;
  cases: {
    header_names: Record<string, string>;
    sendgrid_headers: HeaderCase[];
    resend_headers: HeaderCase[];
    force_sendgrid: { recipients: string | (string | null)[] | null; result: boolean }[];
    delivery_options: { domain: string; provider: string; seller_level?: string; options: Record<string, string | null> }[];
    delivery_option_errors: { domain: string; seller: boolean; error: string }[];
    sendgrid_equivalent: { settings: Record<string, string>; result: Record<string, string | null> | null }[];
    router: { name: string; domain: string; today: string; features: Record<string, boolean>; redis: Record<string, string>; rands: number[]; result: string; rands_used: number[]; redis_after: Record<string, string> }[];
    fold: { name: string; value: string; encoded: string }[];
    from_domain: { from: string; domain: string; subject: string | null; error: string | null }[];
    messages: MessageCase[];
    jobs: JobCase[];
    dispute_reminder: { args: JsonValue[]; queued: string[]; now: number };
  };
};

export const golden = JSON.parse(readFileSync(new URL("application-mailer.golden.json", import.meta.url), "utf8")) as Golden;

// What the generator's environment held; returns a function that restores the previous values.
export function useGoldenEnvironment(): () => void {
  const saved: Record<string, string | undefined> = {};
  const set = (key: string, value: string) => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };
  const dir = mkdtempSync(path.join(tmpdir(), "mail-public-"));
  mkdirSync(path.join(dir, "vite", ".vite"), { recursive: true });
  mkdirSync(path.join(dir, "vite", "assets"), { recursive: true });
  writeFileSync(path.join(dir, "vite", ".vite", "manifest.json"), JSON.stringify({ "entrypoints/email.ts": { file: "assets/email.js", css: ["assets/email-golden.css"] } }));
  writeFileSync(path.join(dir, "vite", "assets", "email-golden.css"), readFileSync(new URL("email.css", import.meta.url)));
  set("RAILS_ENV", "production");
  set("MAIL_PUBLIC_DIR", dir);
  set("TZ", "UTC");
  for (const [key, value] of Object.entries(golden.secrets)) set(key, value);
  setCredentialsForTesting({});
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCredentialsForTesting(undefined);
  };
}

// The generator's OpenSSL::Cipher#random_iv: "ws35-iv-%08d", restarting for every case.
export function goldenIvs(): () => Buffer {
  let seq = 0;
  return () => Buffer.from(`ws35-iv-${String(++seq).padStart(8, "0")}`);
}

// Router dependencies over an in-memory Redis holding `redis`, with the case's flags and rands.
export function goldenRouter(input: { features: string[]; redis: Record<string, string>; rands: number[]; today?: string }): RouterDeps & { redis: Map<string, string> } {
  const redis = new Map(Object.entries(input.redis));
  const rands = [...input.rands];
  return {
    redis,
    featureActive: async (name) => input.features.includes(name),
    redisGet: async (key) => redis.get(key) ?? null,
    redisIncr: async (key) => {
      const next = Number(redis.get(key) ?? "0") + 1;
      redis.set(key, String(next));
      return next;
    },
    rand: () => {
      const value = rands.shift();
      if (value === undefined) throw new Error("no pinned Kernel.rand left");
      return value;
    },
    today: () => input.today ?? golden.now.slice(0, 10),
  };
}

// The Date, Message-ID and boundary Mail picked at random, read back from the recorded message.
export function identityOf(encoded: string): MimeIdentity {
  return {
    date: new Date(/^Date: (.*)\r$/mu.exec(encoded)![1]!),
    messageId: /^Message-ID: (.*)\r$/mu.exec(encoded)![1]!,
    boundary: /boundary="([^"]+)"/u.exec(encoded)![1]!,
  };
}
