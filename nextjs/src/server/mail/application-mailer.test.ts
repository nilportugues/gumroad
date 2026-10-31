import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { golden, goldenIvs, goldenRouter, identityOf, type MessageCase, useGoldenEnvironment } from "./__fixtures__/application-mailer-golden.ts";
import type { JobsRuntime } from "../jobs/runtime.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { buildMailDeliveryItem, keywordArgs } from "./active-job.ts";
import { validateFromEmailDomain } from "./application-mailer.ts";
import { composeMail, type ComposedMail } from "./compose.ts";
import { performMailDelivery, renderNodeMailer } from "./delivery.ts";
import {
  buildHeaders,
  decryptHeader,
  deliveryMethodOptions,
  determineEmailProvider,
  type EmailProvider,
  forceSendgridForRecipients,
  headerName,
  type MailDomain,
  type MailerInfoField,
  type MailerLevel,
  mailDomains,
  sendgridEquivalentOptions,
} from "./mailer-info.ts";
import { unstructured } from "./mime.ts";
import { deserializeArgument, RubyHash, RubySymbol, type RubyValue } from "./ruby-value.ts";

let restore: () => void;
beforeAll(() => {
  restore = useGoldenEnvironment();
});
afterAll(() => restore());

// The Ruby literals generate-application-mailer-golden.rb's ARGS holds, in the same order.
const sym = (name: string) => new RubySymbol(name);
const hash = (...entries: [RubyValue, RubyValue][]) => new RubyHash(entries);
const ARGS: RubyValue[][] = [
  [],
  [42],
  [1, 2, null, true, false],
  ["short", "exactly twenty chars", "twenty-one characters", "a string well over twenty characters long"],
  ['quote " back\\slash', "tab\tnew\nline", "\x1b\x07\b\v\f\r\u0001\u007f", "#{interp} #$g #@i #plain"],
  ["<script>&amp;</script>"],
  [hash([sym("marketing_action_id"), 5])],
  [hash([sym("user_id"), 1], [sym("email"), "buyer@example.com"], [sym("subject"), "s"], [sym("body"), null], [sym("if"), 1], [sym("x="), 2], [sym("a?"), 3], [sym("B!"), 4])],
  [hash(["string", "key"], [3, [1, hash([sym("nested"), sym("sym")])]], [null, null])],
  [[1, [2, [3]]], hash()],
  [-12, 9_007_199_254_740_993n],
  [sym("a"), sym("b?"), sym("C"), sym("c!"), sym("d="), sym("@iv"), sym("needs quotes")],
];

describe("MailerInfo", () => {
  it("names the X-GUM headers", () => {
    for (const [field, name] of Object.entries(golden.cases.header_names)) expect(headerName(field as MailerInfoField)).toBe(name);
  });

  it("builds the SendGrid headers, with the arguments' Ruby inspect", () => {
    golden.cases.sendgrid_headers.forEach((c, i) => {
      const args = i < ARGS.length ? ARGS[i]! : [1];
      expect(Object.fromEntries(buildHeaders({ mailerClass: c.mailer_class, mailerMethod: c.mailer_method, mailerArgs: args, emailProvider: "sendgrid" }))).toEqual(c.headers);
    });
  });

  it("builds the encrypted Resend headers in the same order", () => {
    const args: RubyValue[][] = [[7], [hash([sym("marketing_action_id"), 5])], []];
    golden.cases.resend_headers.forEach((c, i) => {
      const headers = buildHeaders({ mailerClass: c.mailer_class, mailerMethod: c.mailer_method, mailerArgs: args[i]!, emailProvider: "resend", randomIv: goldenIvs() });
      expect(headers).toEqual(Object.entries(c.headers));
      expect(Object.fromEntries(headers.map(([k, v]) => [k, v.startsWith("v1:") ? decryptHeader(v) : v]))).toEqual(c.decrypted);
    });
  });

  it("forces SendGrid for United Internet recipients", () => {
    for (const c of golden.cases.force_sendgrid) expect([c.recipients, forceSendgridForRecipients(c.recipients)]).toEqual([c.recipients, c.result]);
  });

  it("picks the credentials for each domain, provider and seller level", () => {
    for (const c of golden.cases.delivery_options) {
      const options = deliveryMethodOptions(c.domain as MailDomain, c.provider as EmailProvider, c.seller_level as MailerLevel | undefined);
      expect({ ...options, password: options.password ?? null }).toEqual(c.options);
    }
    expect(mailDomains()).toEqual({ gumroad: "gumroad.com", followers: "followers.gumroad.com", creators: "creators.gumroad.com", customers: "customers.gumroad.com" });
    for (const c of golden.cases.delivery_option_errors) {
      expect(() => deliveryMethodOptions(c.domain as MailDomain, "sendgrid", c.seller ? "level_1" : undefined)).toThrow(c.error);
    }
  });

  it("maps Resend settings to the SendGrid equivalent", () => {
    for (const c of golden.cases.sendgrid_equivalent) expect(sendgridEquivalentOptions(c.settings)).toEqual(c.result);
  });

  it("splits traffic between the providers as the Router does", async () => {
    for (const c of golden.cases.router) {
      const before: Record<string, string> = {};
      const date = c.redis.date ?? c.today;
      if (c.redis.probability !== undefined) before[`mail_router:probability:${c.domain}:${date}`] = c.redis.probability;
      if (c.redis.max_count !== undefined) before[`mail_router:max_count:${c.domain}:${date}`] = c.redis.max_count;
      if (c.redis.counter !== undefined) before[`mail_router:counter:${c.domain}:${date}`] = c.redis.counter;
      const deps = goldenRouter({ features: Object.keys(c.features), redis: before, rands: c.rands, today: c.today });
      expect([c.domain, c.name, await determineEmailProvider(c.domain as MailDomain, deps)]).toEqual([c.domain, c.name, c.result]);
      expect(Object.fromEntries(deps.redis)).toEqual(c.redis_after);
    }
  });
});

describe("Mail header folding", () => {
  it("folds unstructured fields as Mail 2.9 encodes them", () => {
    for (const c of golden.cases.fold) expect(`${unstructured(c.name, c.value)}\r\n`).toBe(c.encoded);
  });
});

describe("ApplicationMailer", () => {
  it("raises when the From domain is not the delivery domain", () => {
    for (const c of golden.cases.from_domain) {
      const check = () => validateFromEmailDomain(c.from, mailDomains()[c.domain as MailDomain]);
      if (c.error === null) expect(check).not.toThrow();
      else expect(check).toThrow(c.error);
    }
  });

  const run = async (c: MessageCase) => {
    const replay = sqlReplay(c.statements);
    const router = goldenRouter({ features: c.features, redis: c.redis_before, rands: c.rands_used });
    const rendered = await renderNodeMailer(c.mailer, c.method, c.job_args.map(deserializeArgument), { router, randomIv: goldenIvs() });
    return { rendered, replay, router };
  };

  for (const c of golden.cases.messages) {
    it(`delivers ${c.mailer}#${c.method} (${c.name}) as Rails does`, async () => {
      const { rendered, replay, router } = await run(c);
      expect(replay.log).toEqual(replay.expected);
      expect(Object.fromEntries(router.redis)).toEqual(c.redis_after);
      if (c.delivered.length === 0) {
        expect(rendered).toBeNull();
        return;
      }
      const delivered = c.delivered[0]!;
      expect(rendered!.html).toBe(c.rendered_html);
      const composed = composeMail(rendered!, { identity: identityOf(delivered.encoded) })!;
      expect(composed.encoded).toBe(delivered.encoded);
      expect([composed.envelopeFrom, composed.envelopeTo]).toEqual([delivered.envelope_from, delivered.envelope_to]);
      const { address, domain, user_name, password, ...fixed } = delivered.settings;
      expect(composed.smtp).toEqual({ address, domain, user_name, password });
      expect(fixed).toEqual({ port: 587, authentication: "plain", enable_starttls_auto: true });
    });
  }
});

// Date, Message-ID and the boundary are random on both sides.
const stable = (encoded: string) => encoded.replace(/^(Date|Message-ID): .*$/gmu, "$1: x").replace(/--==_mimepart_[\w-]+/gu, "B");

describe("performMailDelivery for ApplicationMailer methods", () => {
  it("runs the job deliver_later pushed and sends through the message's own SMTP settings", async () => {
    const c = golden.cases.messages.find((m) => m.name === "reconnect_gmx_redirected")!;
    const replay = sqlReplay(c.statements);
    const item = buildMailDeliveryItem({ mailer: c.mailer, method: c.method, args: [keywordArgs({ marketing_action_id: 5 })] }, { jobId: "j", jid: "0".repeat(24), now: 1 });
    expect((item.args as { arguments: JsonValue[] }[])[0]!.arguments[3]).toEqual({ args: c.job_args, _aj_ruby2_keywords: ["args"] });
    const sent: ComposedMail[] = [];
    const runtime = { now: () => 1, newJid: () => "1".repeat(24) } as unknown as JobsRuntime;
    await performMailDelivery(runtime, item, {
      send: async (mail) => void sent.push(mail),
      log: () => {},
      mailer: { router: goldenRouter({ features: c.features, redis: c.redis_before, rands: c.rands_used }), randomIv: goldenIvs() },
    });
    expect(replay.log).toEqual(replay.expected);
    expect(sent.map((mail) => stable(mail.encoded))).toEqual([stable(c.delivered[0]!.encoded)]);
    expect(sent[0]!.smtp).toEqual({ address: "smtp.sendgrid.net", domain: "gumroad.com", user_name: "apikey", password: "sg-gumroad-key" });
  });
});
