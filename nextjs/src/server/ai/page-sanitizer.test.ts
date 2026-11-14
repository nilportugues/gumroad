import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import * as sanitizer from "./page-sanitizer.ts";
import { sanitizeWithReport } from "./page-sanitizer.ts";

type Golden = {
  cases: {
    name: string;
    origin: "handwritten" | "random" | "parser";
    html: string | null;
    ok?: { html: string; report: unknown };
    error?: string;
  }[];
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/ai-page-sanitizer.golden.json"), "utf8"),
) as Golden;

// Inputs the port refuses (a hand-back to Rails) because it cannot prove Ruby's answer.
const HANDED_BACK_BY_NAME = new Set([
  "deep nesting the parser refuses",
  "attributes outside the allowlist",
  "xml namespaced attributes",
]);

function attempt(html: string | null) {
  try {
    return { served: sanitizeWithReport(html) };
  } catch (error) {
    if (error instanceof NotPortedError) return { refused: error.message };
    throw error;
  }
}

describe("Ai::PageSanitizer against Ruby (nextjs/scripts/golden/ai-page-sanitizer.rb)", () => {
  it("has no Ruby errors in the corpus, so every refusal is the port's own", () => {
    expect(golden.cases.filter((c) => c.error !== undefined)).toEqual([]);
  });

  for (const origin of ["handwritten", "random", "parser"] as const) {
    it(`answers every ${origin} case byte for byte or refuses it`, () => {
      let served = 0;
      let refused = 0;
      for (const c of golden.cases.filter((x) => x.origin === origin)) {
        const outcome = attempt(c.html);
        if (outcome.refused !== undefined) {
          refused += 1;
          continue;
        }
        served += 1;
        expect([c.name, outcome.served]).toEqual([c.name, c.ok]);
      }
      // A refusal is allowed but must stay rare: a port that refuses everything proves nothing.
      expect(served).toBeGreaterThan(refused * 8);
    });
  }

  it("refuses exactly the handwritten shapes it cannot prove, and serves the rest", () => {
    const refused = golden.cases
      .filter((c) => c.origin === "handwritten" && attempt(c.html).refused !== undefined)
      .map((c) => c.name)
      .sort();
    expect(refused).toEqual([...HANDED_BACK_BY_NAME].sort());
  });
});

describe("what the port refuses", () => {
  const refuses = (html: string) => expect(() => sanitizeWithReport(html)).toThrow("is not ported");

  it("refuses markup nested deeper than the parser port", () => refuses("<div>".repeat(300)));
  it("refuses a script src it cannot read as a URL", () => refuses('<script src="https://[::1]/x.js"></script>'));
  it("refuses a stylesheet href it cannot read as a URL", () =>
    refuses('<link rel="stylesheet" href="https://[fonts.googleapis.com]/a">'));
  it("refuses a URL attribute that percent-decodes to invalid UTF-8", () => refuses('<a href="%ff">x</a>'));
  it("refuses a URL attribute whose second decode is invalid UTF-8", () => refuses('<a href="%25ff">x</a>'));
  it("refuses an xml: prefixed attribute, which Nokogiri turns into a namespaced one on a fragment root", () => {
    refuses('<div xml:lang="en">x</div>');
    refuses('<p><span xml:space="preserve">x</span></p>');
  });

  it("treats a non-https script src as removed without reading it further", () => {
    const { html, report } = sanitizeWithReport('<script src="ftp://cdn.jsdelivr.net/a b"></script>');
    expect(html).toBe("");
    expect(report.removed_tags[0]?.reason).toBe("script src host not allowed");
  });

  it("does not treat the Kelvin sign as a k in target", () => {
    expect(sanitizeWithReport('<a href="x" target="_blanK">x</a>').html).not.toContain("noopener");
  });
});

describe("constants against app/services/ai/page_sanitizer.rb", () => {
  const ruby = readFileSync(path.join(import.meta.dirname, "../../../../app/services/ai/page_sanitizer.rb"), "utf8");
  const list = (name: string) =>
    (new RegExp(`${name} = %w\\[([^\\]]*)\\]`, "u").exec(ruby)?.[1] ?? "").split(/\s+/u).filter((w) => w !== "");

  it("lists the same tags", () => expect(sanitizer.ALLOWED_TAGS).toEqual(list("ALLOWED_TAGS")));
  it("lists the same attributes", () => expect(sanitizer.ALLOWED_ATTRIBUTES).toEqual(list("ALLOWED_ATTRIBUTES")));
  it("lists the same script hosts", () => expect(sanitizer.ALLOWED_SCRIPT_HOSTS).toEqual(list("ALLOWED_SCRIPT_HOSTS")));
  it("lists the same stylesheet hosts", () =>
    expect(sanitizer.ALLOWED_STYLESHEET_HOSTS).toEqual(list("ALLOWED_STYLESHEET_HOSTS")));
  it("uses the same removal reason for iframes", () =>
    expect(ruby).toContain(`IFRAME_REMOVAL_REASON = %(${sanitizer.IFRAME_REMOVAL_REASON})`));
  it("caps the report at the same size", () =>
    expect(ruby).toContain(`MAX_REPORT_ENTRIES = ${sanitizer.MAX_REPORT_ENTRIES}`));
});
