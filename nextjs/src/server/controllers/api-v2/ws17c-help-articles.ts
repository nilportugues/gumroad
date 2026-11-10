// Api::V2::HelpArticlesController: Gumroad's own help center as plain text, for the store agent.
import { inspect, MailArgumentNotPortedError, RubyHash, type RubyValue } from "../../mail/ruby-value.ts";
import { articleText, index as allArticles, search, summary } from "../../page-props/help-article-text.ts";
import { findArticleBySlug } from "../../page-props/help-center.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";

import { authorize, halted, PUBLIC_READ_SCOPES, renderResponse, type ApiCall } from "./ws17c-base.ts";

// `expires_in 1.hour`
const CACHE_CONTROL = "max-age=3600, private";

function toRuby(value: unknown): RubyValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(toRuby);
  if (typeof value === "object" && value !== null)
    return new RubyHash(Object.entries(value).map(([key, item]): [RubyValue, RubyValue] => [key, toRuby(item)]));
  throw new HandBackToRails("a query value Ruby would read differently");
}

const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === false ||
  (typeof value === "string" && value.trim() === "") ||
  (typeof value === "object" && Object.keys(value as object).length === 0);

// `params[:query].present?` then `query.to_s`: a list or hash query is searched by the words in its #inspect.
function queryText(query: unknown): string | null {
  if (isBlank(query)) return null;
  if (typeof query === "string") return query;
  try {
    return inspect(toRuby(query));
  } catch (error) {
    if (error instanceof MailArgumentNotPortedError)
      throw new HandBackToRails("a query whose Ruby inspect is not ported");
    throw error;
  }
}

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const { query } = call.params;
  const text = queryText(query);
  const articles = text !== null ? search(text) : allArticles();
  return {
    ...renderResponse(true, { help_articles: articles, count: articles.length }),
    headers: { "cache-control": CACHE_CONTROL },
  };
}

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const article = findArticleBySlug(call.routeParams.slug!);
  if (article === null)
    return renderResponse(false, {
      message: "The help article was not found. Call the list endpoint to see the available slugs.",
    });
  return {
    ...renderResponse(true, { help_article: { ...summary(article), content: articleText(article) } }),
    headers: { "cache-control": CACHE_CONTROL },
  };
}
