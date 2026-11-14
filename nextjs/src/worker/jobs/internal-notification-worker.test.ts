// Replays internal-notification.golden.json (generate-internal-notification-golden.rb): the real
// InternalNotificationWorker run by the Rails app in production mode with a recording SMTP socket and
// a local S3. The Node worker must make the same S3 requests and send the same message.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCredentialsForTesting } from "../../server/infra/config.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { goldenRouter } from "../../server/mail/__fixtures__/application-mailer-golden.ts";
import { composeMail, type ComposedMail } from "../../server/mail/compose.ts";
import { renderNodeMailer } from "../../server/mail/delivery.ts";
import { RubyHash, RubySymbol } from "../../server/mail/ruby-value.ts";
import { useS3ClientForTesting } from "../../server/mail/s3-object.ts";
import { SmtpError } from "../../server/mail/smtp.ts";

import { contextFor, recordingSidekiqRedis } from "./__fixtures__/golden.ts";
import { internalNotificationWorkerWith } from "./internal-notification-worker.ts";

type Request = { method: string; path: string; query: string | null; headers: Record<string, string> };
type Case = {
  name: string;
  args: JsonValue[];
  objects: Record<string, { size: number; base64: string | null }>;
  features: string[];
  error: { class: string; message: string } | null;
  s3_requests: Request[];
  ivs: string[];
  delivered: {
    settings: Record<string, string | number | boolean>;
    encoded: string;
    envelope_from: string;
    envelope_to: string[];
  }[];
};
const golden = JSON.parse(
  readFileSync(new URL("../../server/mail/__fixtures__/internal-notification.golden.json", import.meta.url), "utf8"),
) as {
  now: string;
  secrets: Record<string, string>;
  cases: Case[];
};

// Cases whose Ruby run ended in an error the SMTP recorder injected.
const SMTP_FAILURES: Record<string, SmtpError> = {
  "smtp rejects the message": new SmtpError("Net::SMTPFatalError", "550 5.7.1 rejected"),
  "smtp timeout": new SmtpError("Net::OpenTimeout", "execution expired"),
};
// What Node leaves to Rails: Mail's encoding of these is not ported, and Ruby's answer is checked in the generator.
const HANDED_BACK = new Set([
  "non-ascii sender",
  "non-ascii message",
  "odd filenames",
  "non-ascii filename",
  "content types and charsets",
  "attachment without a filename",
]);

const restore: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [key, value] of Object.entries({ RAILS_ENV: "production", TZ: "UTC", ...golden.secrets })) {
    restore[key] = process.env[key];
    process.env[key] = value;
  }
  setCredentialsForTesting({});
});
afterAll(() => {
  for (const [key, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setCredentialsForTesting(undefined);
  useS3ClientForTesting(undefined);
});

// The objects a case holds, by request path, served the way the generator's socket served them.
function bodyOf(object: { size: number; base64: string | null }): Buffer {
  return object.base64 === null ? Buffer.alloc(object.size, "x") : Buffer.from(object.base64, "base64");
}

async function withS3<T>(c: Case, run: (requests: Request[]) => Promise<T>): Promise<T> {
  const requests: Request[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const [path, query] = request.url!.split("?");
    requests.push({
      method: request.method!,
      path: path!,
      query: query ?? null,
      headers: request.headers as Record<string, string>,
    });
    const object = c.objects[path!];
    if (!object) {
      response
        .writeHead(404, { "content-type": "application/xml" })
        .end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`,
        );
      return;
    }
    const body = bodyOf(object);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
      etag: '"etag"',
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  useS3ClientForTesting(
    new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  );
  try {
    return await run(requests);
  } finally {
    server.close();
  }
}

// The JavaScript SDK names the operation in an x-id query parameter that S3 ignores; the request line
// is otherwise the same, and no header that changes what S3 answers may appear.
const significant = (request: Request) => ({
  method: request.method,
  path: request.path,
  query: request.query === "x-id=GetObject" ? null : request.query,
});
const checksumHeaders = (request: Request) =>
  Object.keys(request.headers).filter(
    (name) => name.startsWith("x-amz-checksum") || name === "range" || name.startsWith("if-"),
  );

const stable = (encoded: string) =>
  encoded.replace(/^(Date|Message-ID): .*$/gmu, "$1: x").replace(/--==_mimepart_[\w-]+/gu, "B");

function mailDeps(c: Case, sent: ComposedMail[]) {
  const ivs = [...c.ivs];
  return {
    send: async (mail: ComposedMail) => {
      const failure = SMTP_FAILURES[c.name];
      if (failure) throw failure;
      sent.push(mail);
    },
    log: () => {},
    mailer: {
      router: goldenRouter({ features: c.features, redis: {}, rands: [] }),
      randomIv: () => Buffer.from(Buffer.from(ivs.shift()!, "base64")),
    },
  };
}

describe("InternalNotificationWorker", () => {
  for (const c of golden.cases.filter((candidate) => !HANDED_BACK.has(candidate.name))) {
    it(c.name, async () => {
      const sent: ComposedMail[] = [];
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        now: () => Date.parse(golden.now) / 1000,
      });
      const handler = internalNotificationWorkerWith({ mail: mailDeps(c, sent) });

      let error: unknown = null;
      const requests = await withS3(c, async (seen) => {
        try {
          await handler(c.args, contextFor(runtime));
        } catch (e) {
          error = e;
        }
        return seen;
      });

      expect(requests.map(significant)).toEqual(c.s3_requests.map(significant));
      requests.forEach((request) => expect(checksumHeaders(request)).toEqual([]));
      // Ruby namespaces its classes (Aws::S3::Errors::NotFound); the Node error names carry only the last part.
      const unnamespaced = (name: string) => name.replace(/^.*::/u, "");
      expect(
        error === null ? null : unnamespaced(error instanceof SmtpError ? error.rubyClass : (error as Error).name),
      ).toEqual(c.error ? unnamespaced(c.error.class) : null);
      expect(sent.length).toBe(c.delivered.length);
      sent.forEach((mail, i) => {
        const delivered = c.delivered[i]!;
        expect(stable(mail.encoded)).toBe(stable(delivered.encoded));
        expect(mail.envelopeFrom).toBe(delivered.envelope_from);
        expect(mail.envelopeTo).toEqual(delivered.envelope_to);
        expect(mail.smtp).toMatchObject({
          address: delivered.settings.address,
          domain: delivered.settings.domain,
          password: delivered.settings.password,
        });
      });
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const name of HANDED_BACK) {
    it(`hands "${name}" back to Rails before sending or reading S3 for an unsupported file`, async () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const sent: ComposedMail[] = [];
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        now: () => Date.parse(golden.now) / 1000,
      });
      const handler = internalNotificationWorkerWith({ mail: mailDeps(c, sent) });
      await withS3(c, async (requests) => {
        await expect(handler(c.args, contextFor(runtime))).rejects.toBeInstanceOf(HandBackToRuby);
        // An unsupported file name or type is found before the first S3 request.
        if (/filename|content types|odd/u.test(name)) expect(requests).toEqual([]);
      });
      expect(sent).toEqual([]);
    });
  }

  it("composes each message exactly as Mail did, down to the Date, Message-ID and both boundaries", async () => {
    for (const c of golden.cases.filter(
      (candidate) => !HANDED_BACK.has(candidate.name) && candidate.delivered.length > 0 && !candidate.error,
    )) {
      const delivered = c.delivered[0]!;
      const [options] = [c.args[4] ?? {}] as [Record<string, JsonValue>];
      const hash = new RubyHash([
        [new RubySymbol("room_name"), c.args[0] as string],
        [new RubySymbol("sender"), c.args[1] as string],
        [new RubySymbol("message_text"), c.args[2] as string],
        [new RubySymbol("attachments_data"), asRuby(options.attachments ?? [])],
        [new RubySymbol("s3_attachments"), asRuby(options.s3_attachments ?? [])],
      ]);
      const ivs = [...c.ivs];
      const rendered = await withS3(c, () =>
        renderNodeMailer("InternalNotificationMailer", "notify", [hash], {
          router: goldenRouter({ features: c.features, redis: {}, rands: [] }),
          randomIv: () => Buffer.from(Buffer.from(ivs.shift()!, "base64")),
        }),
      );
      const boundaries = [...delivered.encoded.matchAll(/boundary="([^"]+)"/gu)].map((match) => match[1]!);
      const identity = {
        date: new Date(/^Date: (.*)\r$/mu.exec(delivered.encoded)![1]!),
        messageId: /^Message-ID: (.*)\r$/mu.exec(delivered.encoded)![1]!,
        boundary: boundaries[0]!,
        ...(boundaries[1] ? { innerBoundary: boundaries[1] } : {}),
      };
      expect(composeMail(rendered!, { identity })!.encoded, c.name).toBe(delivered.encoded);
    }
  });
});

describe("InternalNotificationWorker recipient settings", () => {
  const variant = JSON.parse(
    readFileSync(
      new URL("../../server/mail/__fixtures__/internal-notification-config.golden.json", import.meta.url),
      "utf8",
    ),
  ) as typeof golden & {
    overrides: Record<string, string>;
  };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(variant.overrides)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const c of variant.cases) {
    it(c.name, async () => {
      const sent: ComposedMail[] = [];
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        now: () => Date.parse(variant.now) / 1000,
      });
      await internalNotificationWorkerWith({ mail: mailDeps(c, sent) })(c.args, contextFor(runtime));
      expect(sent.map((mail) => stable(mail.encoded))).toEqual(
        c.delivered.map((delivered) => stable(delivered.encoded)),
      );
      expect(sent.map((mail) => mail.envelopeTo)).toEqual(c.delivered.map((delivered) => delivered.envelope_to));
    });
  }
});

describe("InternalNotificationWorker outside production", () => {
  it("hands the job to Rails, whose subject prefix and SMTP settings differ", async () => {
    const previous = process.env.RAILS_ENV;
    process.env.RAILS_ENV = "staging";
    try {
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, now: () => 0 });
      await expect(
        internalNotificationWorkerWith({ mail: mailDeps(golden.cases[0]!, []) })(
          ["risk", "Iffy", "Hi"],
          contextFor(runtime),
        ),
      ).rejects.toBeInstanceOf(HandBackToRuby);
    } finally {
      process.env.RAILS_ENV = previous;
    }
  });
});

function asRuby(value: JsonValue): never {
  if (Array.isArray(value)) return value.map(asRuby) as never;
  if (value !== null && typeof value === "object")
    return new RubyHash(Object.entries(value).map(([key, entry]) => [key, asRuby(entry as JsonValue)])) as never;
  return value as never;
}
