import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import digests from "./__fixtures__/help-center-article-digests.json";
import { helpCenterData } from "./help-center.ts";
import { renderArticleContent } from "./help-center-erb.ts";

// SHA-256 of `view_context.render(article)` for every article, rendered by Rails in the test
// environment (HelpCenterPresenter#article_props) for a request to app.test.gumroad.com:31337.
// Regenerate with scripts/dump-help-center-article-digests.rb when a template changes.
const options = { urlOptions: { protocol: "http", host: "app.test.gumroad.com:31337" }, assetHost: null };

describe("help center article templates", () => {
  const slugs = helpCenterData().articles.map((article) => article.slug);

  it("covers every article", () => {
    expect(Object.keys(digests).sort()).toEqual([...slugs].sort());
  });

  it.each(slugs)("renders %s byte for byte like Rails", (slug) => {
    const content = renderArticleContent(slug, options);
    expect(createHash("sha256").update(content).digest("hex")).toBe((digests as Record<string, string>)[slug]);
  });

  it("prefixes public assets with the asset host", () => {
    const content = renderArticleContent("37-how-to-delete-your-gumroad-account", { ...options, assetHost: "https://assets.example.com" });
    expect(content).toContain('<img src="https://assets.example.com/images/help_center/delete-account-confirmation.png" />');
  });
});
