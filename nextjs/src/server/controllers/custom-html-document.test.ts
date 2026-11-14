import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import golden from "./__fixtures__/custom-html-document.golden.json" with { type: "json" };
import {
  customHtmlBackgroundWrapperScript,
  customHtmlFollowWrapperScript,
  customHtmlLiveReloadScript,
  customHtmlNavigationBridgeScript,
  FOLLOW_BRIDGE_SCRIPT,
  pagesTailwindHead,
  PRODUCTS_BRIDGE_SCRIPT,
  profileCustomHtmlDocument,
  themeBackgroundCss,
} from "./custom-html-document.ts";

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
      navigation_bridge?: string;
      follow_bridge?: string;
      products_bridge?: string;
    };
    it(c.name, () => {
      expect(
        profileCustomHtmlDocument(c.custom_html, {
          dataJson: args.data_json,
          pricesJson: args.prices_json,
          scrollToChange: args.scroll_to_change,
          liveFields: args.live_fields,
          navigationBridge: args.navigation_bridge,
          followBridge: args.follow_bridge,
          productsBridge: args.products_bridge,
          tailwindHead,
        }),
      ).toBe(c.document);
    });
  }

  it("refuses a page with a sharp s, where Ruby's case-insensitive match reads it as ss", () => {
    expect(() => profileCustomHtmlDocument("<p>Straße</p>", { tailwindHead: "" })).toThrow(NotPortedError);
  });
});

describe("custom_html_navigation_bridge_script against Ruby", () => {
  const TEST_VALID_HOSTS = ["127.0.0.1", "app.test.gumroad.com", "test.gumroad.com"];

  for (const c of golden.navigation_bridges) {
    it(`fills ${JSON.stringify(c.allowed_hostnames)}`, () => {
      expect(customHtmlNavigationBridgeScript(c.allowed_hostnames, TEST_VALID_HOSTS)).toBe(c.script);
    });
  }

  it("keeps the follow and products bridges the documents embed", () => {
    for (const c of golden.documents.filter((entry) => "follow_bridge" in entry.arguments)) {
      expect(c.document).toContain(FOLLOW_BRIDGE_SCRIPT);
      expect(c.document).toContain(PRODUCTS_BRIDGE_SCRIPT);
    }
  });
});

describe("the trusted wrapper's scripts against Ruby", () => {
  for (const c of golden.wrapper_scripts) {
    const { seller_external_id: id, nonce, version_src: versionSrc } = c.arguments;
    it(`fills ${JSON.stringify(c.arguments)}`, () => {
      expect(customHtmlFollowWrapperScript(id, nonce)).toBe(c.follow);
      expect(customHtmlBackgroundWrapperScript(nonce)).toBe(c.background);
      expect(customHtmlLiveReloadScript(versionSrc, nonce)).toBe(c.live_reload);
    });
  }

  for (const c of golden.safe_css_colors) {
    it(`reads ${JSON.stringify(c.value)} as ${c.safe ? "safe" : "unsafe"} for CSS`, () => {
      expect(themeBackgroundCss(c.value)).toBe(c.safe ? `html{background:${c.value}}` : "");
    });
  }
});
