import { describe, expect, it, vi } from "vitest";

import type { ApiCall } from "./ws17c-base.ts";

const { search, index: allArticles } = vi.hoisted(() => ({
  search: vi.fn((_query: string) => [{ slug: "found" }]),
  index: vi.fn(() => [{ slug: "all" }]),
}));

vi.mock("../../page-props/help-article-text.ts", () => ({
  articleText: vi.fn(),
  index: allArticles,
  search,
  summary: vi.fn(),
}));
vi.mock("../../page-props/help-center.ts", () => ({ findArticleBySlug: vi.fn() }));

const { index } = await import("./ws17c-help-articles.ts");

const run = (query: unknown) =>
  index({ params: query === undefined ? {} : { query }, routeParams: {} } as unknown as ApiCall);
const slugs = async (query: unknown) =>
  (JSON.parse(String((await run(query)).body)) as { help_articles: { slug: string }[] }).help_articles.map(
    (article) => article.slug,
  );

describe("Api::V2::HelpArticlesController#index query", () => {
  it("lists every article for a missing, null, empty or blank query", async () => {
    for (const query of [undefined, null, "", "  ", [], {}, false]) expect(await slugs(query)).toEqual(["all"]);
    expect(search).not.toHaveBeenCalled();
  });

  it("searches a string query as given", async () => {
    expect(await slugs("refund policy")).toEqual(["found"]);
    expect(search).toHaveBeenLastCalledWith("refund policy");
  });

  it("searches a list query by the words of its Ruby to_s", async () => {
    await run(["refund", "policy"]);
    expect(search).toHaveBeenLastCalledWith('["refund", "policy"]');
  });

  it("searches a hash query by the words of its Ruby to_s", async () => {
    await run({ a: "refund" });
    expect(search).toHaveBeenLastCalledWith('{"a" => "refund"}');
  });

  it("searches a number or true by its to_s", async () => {
    await run(42);
    expect(search).toHaveBeenLastCalledWith("42");
    await run(true);
    expect(search).toHaveBeenLastCalledWith("true");
  });

  it("hands back a query whose Ruby inspect is not ported", async () => {
    await expect(run(["café"])).rejects.toThrow(/inspect/u);
    await expect(run(1.5)).rejects.toThrow(/Ruby/u);
  });
});
