import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import digests from "./__fixtures__/help-article-text-digests.json";
import { helpCenterData } from "./help-center.ts";
import { renderPlainText, search } from "./help-article-text.ts";

// SHA-256 of `HelpCenter::ArticleText.render_plain_text(article)` for every article, produced by Rails in the test environment.
// Regenerate with nextjs/scripts/dump-help-article-text-digests.rb when a template changes.
describe("help article plain text", () => {
  const articles = helpCenterData().articles;

  it("covers every article", () => {
    expect(Object.keys(digests).sort()).toEqual(articles.map((article) => article.slug).sort());
  });

  it.each(articles.map((article) => article.slug))("reduces %s to the text Rails does", (slug) => {
    expect(createHash("sha256").update(renderPlainText({ slug })).digest("hex")).toBe((digests as Record<string, string>)[slug]);
  });

  it("finds articles by the words of a question, headline hits first", () => {
    const results = search("how do I delete my account?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe("37-how-to-delete-your-gumroad-account");
  });
});
