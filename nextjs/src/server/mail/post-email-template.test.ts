// The rendered post email against the SendGrid requests scripts/golden/post-email-sends.rb recorded:
// SendGrid carries the template with its `{{...}}` tokens still in place.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { useGoldenEnvironment } from "./__fixtures__/application-mailer-golden.ts";
import { PostEmailNotPortedError, renderPostEmail, type PostEmailView } from "./post-email-template.ts";

type Request = { content: { type: string; value: string }[] };
type Case = { name: string; error: { class: string } | null; providers: { provider: string; request: Request }[] };
const golden = JSON.parse(readFileSync(new URL("../../worker/jobs/__fixtures__/post-email-sends.golden.json", import.meta.url), "utf8")) as { cases: Case[] };

let restore: () => void;
beforeAll(() => {
  restore = useGoldenEnvironment();
});
afterAll(() => restore());

const base: PostEmailView = {
  subject: "Welcome",
  message: "<p>Hello and thanks for your purchase.</p>",
  callToActionUrl: null,
  callToActionText: null,
  hasPostUrl: false,
  hasDownloadButton: false,
  hasCommentButton: false,
  hasSellerUpdateReason: true,
  profile: null,
};
const withProfile = { hasPostUrl: true, hasCommentButton: true };

const VIEWS: Record<string, Partial<PostEmailView>> = {
  "purchase: sendgrid": {},
  "purchase: shown on profile with comments": withProfile,
  "purchase: call to action": { callToActionUrl: "https://example.com/offer?a=1&b=2", callToActionText: "Get <it>" },
  "purchase: long message": { message: `<p>${"Lorem ipsum dolor sit amet. ".repeat(30)}</p><h2>Heading</h2><ul><li>One</li><li>Two &amp; three</li></ul><p><strong>Bold</strong> and <em>italic</em><br>line</p>` },
  "purchase: message with links": { message: '<p>See https://example.com/a?b=1&amp;c=2 or write to me@example.com or www.example.org.</p><p><a href="https://example.net">link</a></p>' },
  "purchase: message without markup": { message: "just text <3 & more" },
  "purchase: message in a right-to-left script": { message: '<p>Hello</p><p>שלום</p><div dir="ltr">x</div><blockquote>q</blockquote>' },
  "purchase: empty message": { message: "" },
  "purchase: product without a name": { subject: "Product 1 - Update" },
  "purchase: seller post": { hasSellerUpdateReason: true },
  "purchase: audience post": { hasSellerUpdateReason: false },
};

describe("post email template", () => {
  for (const [name, overrides] of Object.entries(VIEWS)) {
    it(name, () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const recorded = c.providers.find((p) => p.provider === "sendgrid")!.request.content;
      const rendered = renderPostEmail({ ...base, ...overrides });
      expect(rendered.plaintext).toBe(recorded.find((part) => part.type === "text/plain")!.value);
      expect(rendered.html).toBe(recorded.find((part) => part.type === "text/html")!.value);
    });
  }

  for (const message of ['<pre><code class="language-ruby">puts 1</code></pre>', '<upsell-card id="abc"></upsell-card>', '<div class="tiptap__raw" data-url="https://example.com"></div>', '<p><a class="tiptap__button" href="https://example.com">Go</a></p>']) {
    it(`refuses ${message}`, () => {
      expect(() => renderPostEmail({ ...base, message })).toThrow(PostEmailNotPortedError);
    });
  }

  it("refuses a seller profile with other colours", () => {
    expect(() => renderPostEmail({ ...base, profile: { font: "Inter", background_color: "#000000", highlight_color: "#112233", border_radius: "small", button_hover: "lift" } })).toThrow(PostEmailNotPortedError);
  });
});
