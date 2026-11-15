import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { composeMail } from "./compose.ts";
import { resolveCustomProperties, rootProperties } from "./premailer/custom-properties.ts";

// Recorded from the real gems and initializers by __fixtures__/generate-qp-resolver-golden.rb: premailer-rails'
// hook, EmailCustomPropertyInlining and QuotedPrintableHtmlMail on Mail#deliver.
process.env.TZ = "UTC";

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/qp-resolver.golden.json", import.meta.url), "utf8")) as {
  cases: { name: string; css: string; rendered_html: string; encoded: string }[];
  direct: { name: string; html: string; css: string; root_properties: Record<string, string>; resolved: string }[];
};

function identityOf(encoded: string) {
  return {
    date: new Date(/^Date: (.*)\r$/mu.exec(encoded)![1]!),
    messageId: /^Message-ID: (.*)\r$/mu.exec(encoded)![1]!,
    boundary: /boundary="([^"]+)"/u.exec(encoded)![1]!,
  };
}

describe("composeMail against Rails with the quoted-printable interceptor and custom property inlining", () => {
  for (const c of golden.cases) {
    it(`encodes ${c.name} byte for byte as Mail#deliver does`, () => {
      const composed = composeMail(
        { from: "Gumroad <noreply@gumroad.com>", to: "buyer@example.com", subject: "Golden", html: c.rendered_html },
        { identity: identityOf(c.encoded), loadStylesheet: () => c.css },
      );
      expect(composed?.encoded).toBe(c.encoded);
    });
  }
});

describe("EmailCustomPropertyResolver", () => {
  for (const c of golden.direct) {
    it(`resolves ${c.name} as Rails does`, () => {
      const roots = rootProperties(c.css);
      expect(Object.fromEntries(roots)).toEqual(c.root_properties);
      expect(resolveCustomProperties(c.html, roots)).toBe(c.resolved);
    });
  }
});
