// Api::V2::HelpArticlesController: Gumroad's own help center as plain text, for the store agent.
import { articleText, index as allArticles, search, summary } from "../../page-props/help-article-text.ts";
import { findArticleBySlug } from "../../page-props/help-center.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { authorize, halted, PUBLIC_READ_SCOPES, renderResponse, type ApiCall } from "./ws17c-base.ts";

// `expires_in 1.hour`
const CACHE_CONTROL = "max-age=3600, private";

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const { query } = call.params;
  if (query !== undefined && query !== null && typeof query !== "string") throw new HandBackToRails("a query that is not a string");
  const articles = typeof query === "string" && query.trim() !== "" ? search(query) : allArticles();
  return { ...renderResponse(true, { help_articles: articles, count: articles.length }), headers: { "cache-control": CACHE_CONTROL } };
}

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const article = findArticleBySlug(call.routeParams.slug!);
  if (article === null) return renderResponse(false, { message: "The help article was not found. Call the list endpoint to see the available slugs." });
  return { ...renderResponse(true, { help_article: { ...summary(article), content: articleText(article) } }), headers: { "cache-control": CACHE_CONTROL } };
}
