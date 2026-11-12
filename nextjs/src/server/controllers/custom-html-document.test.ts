import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import golden from "./__fixtures__/custom-html-document.golden.json" with { type: "json" };
import { pagesTailwindHead, profileCustomHtmlDocument } from "./custom-html-document.ts";

const ASSET_HOST = "http://test.gumroad.com:31337";

const roots: string[] = [];
function buildTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "tailwind-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MANIFEST = "public/pages-tailwind-manifest.json";
const ASSET = "public/assets/pages/pages-tailwind-0123abcd.css";
const INLINE = "public/pages-tailwind.css";
const entry = (value: unknown, key = "pages-tailwind.css") => JSON.stringify({ [key]: value });
const FINGERPRINTED = "assets/pages/pages-tailwind-0123abcd.css";

// The trees nextjs/scripts/golden/custom-html-document.rb builds for each state.
const TREES: Record<string, Record<string, string>> = {
  "no build output": {},
  "only the inline stylesheet": { [INLINE]: "body{margin:0}\n" },
  "a manifest that is not JSON": { [INLINE]: "body{margin:0}\n", [MANIFEST]: "{ not json" },
  "a manifest whose asset is missing": { [INLINE]: "body{margin:0}\n", [MANIFEST]: entry(FINGERPRINTED) },
  "a manifest and its asset": { [INLINE]: "body{margin:0}\n", [MANIFEST]: entry(FINGERPRINTED), [ASSET]: "x" },
  "a manifest path outside the build directory": {
    [INLINE]: "body{margin:0}\n",
    [MANIFEST]: entry("assets/other/pages-tailwind-0123abcd.css"),
    [ASSET]: "x",
  },
  "a manifest path that is not text": { [INLINE]: "body{margin:0}\n", [MANIFEST]: entry(5), [ASSET]: "x" },
  "a manifest without the entry": {
    [INLINE]: "body{margin:0}\n",
    [MANIFEST]: entry(FINGERPRINTED, "other.css"),
    [ASSET]: "x",
  },
  "a manifest that is a list": { [INLINE]: "body{margin:0}\n", [MANIFEST]: "[]", [ASSET]: "x" },
};

describe("pages_tailwind_head against Ruby (nextjs/scripts/golden/custom-html-document.rb)", () => {
  it("covers every state the generator builds", () => {
    expect(Object.keys(TREES).sort()).toEqual(Object.keys(golden.tailwind_head).sort());
  });

  for (const [name, expected] of Object.entries(golden.tailwind_head)) {
    if (typeof expected !== "string") {
      it(`refuses ${name}, where Ruby raises ${expected.error}`, () => {
        expect(() => pagesTailwindHead(ASSET_HOST, buildTree(TREES[name]!))).toThrow(NotPortedError);
      });
      continue;
    }
    it(`reads ${name}`, () => {
      expect(pagesTailwindHead(ASSET_HOST, buildTree(TREES[name]!))).toBe(expected);
    });
  }
});

describe("profile_custom_html_document against Ruby", () => {
  const tailwindHead = golden.tailwind_head_without_build;

  for (const c of golden.documents) {
    const args = c.arguments as {
      data_json?: string;
      prices_json?: string;
      scroll_to_change?: boolean;
      live_fields?: boolean;
    };
    if (args.live_fields) {
      it(`${c.name} is not built here`, () => {
        // The preview never shows live fields; the builder has no argument for them.
        expect(c.document).toContain("gumroad:profile-fields");
      });
      continue;
    }
    it(c.name, () => {
      expect(
        profileCustomHtmlDocument(c.custom_html, {
          dataJson: args.data_json,
          pricesJson: args.prices_json,
          scrollToChange: args.scroll_to_change,
          tailwindHead,
        }),
      ).toBe(c.document);
    });
  }

  it("refuses a page with a sharp s, where Ruby's case-insensitive match reads it as ss", () => {
    expect(() => profileCustomHtmlDocument("<p>Straße</p>", { tailwindHead: "" })).toThrow(NotPortedError);
  });
});
