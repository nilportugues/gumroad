import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { encodeMessage, encodePart, MimeNotPortedError, packBase64, packM, rfc2822Date } from "./mime.ts";

// The goldens were rendered under TZ=UTC; Date follows the process zone on both sides.
process.env.TZ = "UTC";

type MessageCase = { name: string; kind: "message"; text_part: string; html_part: string; encoded: string };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/mail.golden.json", import.meta.url), "utf8")) as { cases: { kind: string }[] };
const mimeGolden = JSON.parse(readFileSync(new URL("./__fixtures__/mime.golden.json", import.meta.url), "utf8")) as {
  name: string;
  body: string;
  pack_m: string;
  pack_m_base64: string;
  part: string;
}[];

// The only values the gem draws at random or from the clock.
function identityOf(encoded: string) {
  const date = /^Date: (.*)\r$/mu.exec(encoded)![1]!;
  const messageId = /^Message-ID: (.*)\r$/mu.exec(encoded)![1]!;
  const boundary = /boundary="([^"]+)"/u.exec(encoded)![1]!;
  return { date: new Date(date), messageId, boundary };
}

describe("encodeMessage", () => {
  const cases = golden.cases.filter((c): c is MessageCase => c.kind === "message");
  for (const c of cases) {
    it(`encodes ${c.name} byte for byte as Mail::Message#encoded`, () => {
      const to = /^To: (.*)\r$/mu.exec(c.encoded)![1]!;
      const subject = /^Subject: (.*)\r$/mu.exec(c.encoded)![1]!;
      const encoded = encodeMessage(
        {
          from: "Gumroad <noreply@gumroad.com>",
          replyTo: "Gumroad <noreply@gumroad.com>",
          to: [to],
          subject,
          parts: [
            { contentType: "text/html", body: c.html_part },
            { contentType: "text/plain", body: c.text_part },
          ],
        },
        identityOf(c.encoded),
      );
      expect(encoded).toBe(c.encoded);
    });
  }

  it("refuses headers the gem would fold or encode", () => {
    const base = { from: "a@example.com", to: ["b@example.com"], parts: [{ contentType: "text/plain" as const, body: "x" }, { contentType: "text/html" as const, body: "y" }] };
    expect(() => encodeMessage({ ...base, subject: "Café" })).toThrow(MimeNotPortedError);
    expect(() => encodeMessage({ ...base, subject: "x".repeat(80) })).toThrow(MimeNotPortedError);
    expect(() => encodeMessage({ ...base, subject: "ok", to: ["Ünï <b@example.com>"] })).toThrow(MimeNotPortedError);
    expect(() => encodeMessage({ ...base, subject: "ok", to: ["b@example.com", "c@example.com"] })).toThrow(MimeNotPortedError);
  });

  it("formats Date as DateTime#strftime does", () => {
    expect(rfc2822Date(new Date(Date.UTC(2026, 9, 31, 17, 1, 8)))).toMatch(/^Sat, 31 Oct 2026 \d\d:01:08 [+-]\d{4}$/u);
  });
});

describe("text part encoding", () => {
  for (const c of mimeGolden) {
    it(`matches the mail gem for ${c.name}`, () => {
      const bytes = Buffer.from(c.body, "utf8");
      expect(packM(bytes)).toBe(c.pack_m);
      expect(packBase64(bytes)).toBe(c.pack_m_base64);
      expect(encodePart({ contentType: "text/plain", body: c.body })).toBe(c.part);
    });
  }
});
