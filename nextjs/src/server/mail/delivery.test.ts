import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobsRuntime } from "../jobs/runtime.ts";
import type { SidekiqItem } from "../jobs/sidekiq/item.ts";
import { type JsonValue, parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { setSqlClient } from "../models/sql.ts";
import type { ComposedMail } from "./compose.ts";
import { SmtpError } from "./smtp.ts";

const pushed: { item: SidekiqItem; route: string }[] = [];
vi.mock("./active-job.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-job.ts")>()),
  pushMailDeliveryItem: async (_runtime: JobsRuntime, item: SidekiqItem, route: string) => void pushed.push({ item, route }),
}));
const { performMailDelivery, mailRoute } = await import("./delivery.ts");

process.env.TZ = "UTC";

type Golden = { cases: { kind: string; name: string; encoded?: string; scheduled?: { payload: string }[] }[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/mail.golden.json", import.meta.url), "utf8")) as Golden;
const enqueued = (name: string) => parseRubyJson(golden.cases.find((c) => c.name === name)!.scheduled![0]!.payload) as SidekiqItem;
const encodedOf = (name: string) => golden.cases.find((c) => c.name === name)!.encoded!;

// What the encoded message carries regardless of the clock and the random tags.
const stable = (encoded: string) => encoded.replace(/^(Date|Message-ID): .*$/gmu, "$1: x").replace(/--==_mimepart_[\w-]+/gu, "B");

const USERS: Record<string, Record<string, string | null>> = {
  "1234": { email: "seller@example.com", unconfirmed_email: null, confirmation_token: "Tok3n-abc_DEF", external_id: "8723460912345" },
  "5678": { email: "old@example.com", unconfirmed_email: "new+tag@example.org", confirmation_token: "zZ9_yY8-xX7", external_id: "1111111111111" },
};

const runtime = { now: () => 1793466100, newJid: () => "0123456789abcdef01234567" } as unknown as JobsRuntime;
let sent: ComposedMail[];
let logged: string[];
const deps = (send: (mail: ComposedMail) => Promise<void> = async (mail) => void sent.push(mail)) => ({ send, log: (m: string) => void logged.push(m), random: () => 0.5 });

const saved = { env: process.env.RAILS_ENV, dir: process.env.MAIL_PUBLIC_DIR };
beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "mail-public-"));
  mkdirSync(path.join(dir, "vite", ".vite"), { recursive: true });
  mkdirSync(path.join(dir, "vite", "assets"), { recursive: true });
  writeFileSync(path.join(dir, "vite", ".vite", "manifest.json"), JSON.stringify({ "entrypoints/email.ts": { file: "assets/email.js", css: ["assets/email-golden.css"] } }));
  writeFileSync(path.join(dir, "vite", "assets", "email-golden.css"), readFileSync(new URL("./__fixtures__/email.css", import.meta.url)));
  process.env.RAILS_ENV = "production";
  process.env.MAIL_PUBLIC_DIR = dir;
  setSqlClient(() => ({
    $queryRaw: (async (sql: { values: unknown[] }) => {
      const row = USERS[String(sql.values[0])];
      return row ? [row] : [];
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
});
afterAll(() => {
  process.env.RAILS_ENV = saved.env;
  process.env.MAIL_PUBLIC_DIR = saved.dir;
});
beforeEach(() => {
  pushed.length = 0;
  sent = [];
  logged = [];
});

describe("performMailDelivery", () => {
  it("delivers the job Rails enqueued with the message ActionMailer would send", async () => {
    await performMailDelivery(runtime, enqueued("deliver_later_confirmation"), deps());
    expect(sent).toHaveLength(1);
    expect(stable(sent[0]!.encoded)).toBe(stable(encodedOf("confirmation_instructions")));
    expect(sent[0]).toMatchObject({ envelopeFrom: "noreply@gumroad.com", envelopeTo: ["seller@example.com"] });

    await performMailDelivery(runtime, enqueued("deliver_later_email_changed"), deps());
    expect(stable(sent[1]!.encoded)).toBe(stable(encodedOf("email_changed")));
    expect(pushed).toEqual([]);
  });

  it("reschedules a transient SMTP failure as retry_on does", async () => {
    const item = enqueued("deliver_later_reconfirmation");
    await performMailDelivery(runtime, item, deps(async () => Promise.reject(new SmtpError("Net::SMTPServerBusy", "451 later"))));
    expect(pushed).toHaveLength(1);
    const retry = pushed[0]!;
    // NODE_MAIL_DELIVERY is off, so the retry goes to Rails.
    expect(retry.route).toBe("ruby");
    const job = (retry.item.args as Record<string, JsonValue>[])[0]!;
    const original = (item.args as Record<string, JsonValue>[])[0]!;
    expect(job).toEqual({
      ...original,
      provider_job_id: item.jid,
      executions: 1,
      exception_executions: { "[Net::OpenTimeout, Net::ReadTimeout, Net::SMTPServerBusy, EOFError]": 1 },
      enqueued_at: "2026-10-31T17:01:40.000000000Z",
      // 1**4 + 0.5 * 1 * 0.15 + 2 seconds later.
      scheduled_at: "2026-10-31T17:01:43.075000000Z",
    });
    expect(retry.item).toMatchObject({ queue: "critical", class: "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper", jid: "0123456789abcdef01234567" });
  });

  it("lets the error reach Sidekiq's retry once retry_on's attempts are spent", async () => {
    const item = enqueued("deliver_later_reconfirmation");
    const job = (item.args as Record<string, JsonValue>[])[0]!;
    job.exception_executions = { "[Net::OpenTimeout, Net::ReadTimeout, Net::SMTPServerBusy, EOFError]": 9 };
    await expect(performMailDelivery(runtime, item, deps(async () => Promise.reject(new SmtpError("Net::ReadTimeout", "x"))))).rejects.toThrow(SmtpError);
    expect(pushed).toEqual([]);
  });

  it("logs and completes on the errors RescueSmtpErrors rescues", async () => {
    await performMailDelivery(runtime, enqueued("deliver_later_confirmation"), deps(async () => Promise.reject(new SmtpError("Net::SMTPFatalError", "550 no such user"))));
    expect(logged).toEqual(["Mailer Error: #<Net::SMTPFatalError: 550 no such user>"]);
    expect(pushed).toEqual([]);
  });

  it("hands mailer methods Node has not ported back to Sidekiq unchanged", async () => {
    const item = enqueued("deliver_later_confirmation");
    const job = (item.args as Record<string, JsonValue>[])[0]!;
    job.arguments = ["UserSignupMailer", "reset_password_instructions", "deliver_now", { args: [], _aj_ruby2_keywords: ["args"] }];
    await performMailDelivery(runtime, item, deps());
    expect(pushed).toEqual([{ item, route: "ruby" }]);
    expect(sent).toEqual([]);
  });

  it("hands a render it cannot reproduce back to Sidekiq", async () => {
    process.env.RAILS_ENV = "staging";
    try {
      const item = enqueued("deliver_later_confirmation");
      await performMailDelivery(runtime, item, deps());
      expect(pushed).toEqual([{ item, route: "ruby" }]);
      expect(sent).toEqual([]);
    } finally {
      process.env.RAILS_ENV = "production";
    }
  });

  it("routes deliveries to Node only when switched on in production", () => {
    expect(mailRoute("UserSignupMailer", "email_changed")).toBe("ruby");
    process.env.NODE_MAIL_DELIVERY = "enabled";
    try {
      expect(mailRoute("UserSignupMailer", "email_changed")).toBe("node");
      expect(mailRoute("CustomerMailer", "receipt")).toBe("ruby");
    } finally {
      delete process.env.NODE_MAIL_DELIVERY;
    }
  });
});
