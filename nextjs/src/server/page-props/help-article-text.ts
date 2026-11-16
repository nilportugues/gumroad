// HelpCenter::ArticleText (app/services/help_center/article_text.rb): an article's ERB partial reduced to the prose a program can read.
import { html4Fragment } from "../html/loofah.ts";
import { allElements, type ElementNode, type FragmentNode, type HtmlNode, insertBefore, removeNode, textContent } from "../html/libxml2-tree.ts";
import { domainConfig } from "./domain.ts";
import { type HelpCenterArticle, helpCenterData } from "./help-center.ts";
import { renderArticleContent } from "./help-center-erb.ts";

// HelpCenter::ArticleText::MAX_LENGTH
export const MAX_LENGTH = 12_000;
// IGNORED_SELECTORS
const IGNORED = new Set(["script", "style", "figure", "img", "svg", "iframe", "video", "source"]);
// The elements whose text goes on its own line.
const BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "div", "br"]);
// STOPWORDS
const STOPWORDS = new Set(
  "a an and any are as at be been by can could do does doing for from get got had has have how i if in into is it its me my of on or our so that the their them then there these this to us was were what when where which who why will with would you your".split(" "),
);

export function articleUrl(article: Pick<HelpCenterArticle, "slug">): string {
  const { protocol, domain } = domainConfig(process.env);
  return `${protocol}://${domain}/help/article/${article.slug}`;
}

const textNode = (content: string): HtmlNode => ({ type: "text", content, parent: null });

// #render_plain_text
export function renderPlainText(article: Pick<HelpCenterArticle, "slug">): string {
  const { protocol, domain } = domainConfig(process.env);
  const fragment: FragmentNode = html4Fragment(renderArticleContent(article.slug, { urlOptions: { protocol, host: domain }, assetHost: null }));
  for (const element of allElements(fragment)) if (IGNORED.has(element.name.toLowerCase()) && element.parent !== null) removeNode(element);
  // Each block's text on its own line: a list of six links must not collapse into one run-on sentence.
  const blocks: ElementNode[] = allElements(fragment).filter((element) => BLOCKS.has(element.name.toLowerCase()));
  for (const block of blocks) {
    const siblings = block.parent!.children;
    const next = siblings[siblings.indexOf(block) + 1];
    if (next) insertBefore(next, [textNode("\n")]);
    else block.parent!.children.push(Object.assign(textNode("\n"), { parent: block.parent }));
  }
  return textContent(fragment)
    .replace(/[ \t]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^[\s\0]+|[\s\0]+$/gu, "");
}

const cache = new Map<string, string>();

// #plain_text, cached for the life of the process (the articles are code).
export function plainText(article: Pick<HelpCenterArticle, "slug">): string {
  let text = cache.get(article.slug);
  if (text === undefined) {
    text = renderPlainText(article);
    cache.set(article.slug, text);
  }
  return text;
}

// String#truncate(MAX_LENGTH, omission:)
export function articleText(article: Pick<HelpCenterArticle, "slug">): string {
  const omission = `\n\n[Article truncated. Read the rest at ${articleUrl(article)}]`;
  const characters = Array.from(plainText(article));
  if (characters.length <= MAX_LENGTH) return characters.join("");
  return characters.slice(0, MAX_LENGTH - Array.from(omission).length).join("") + omission;
}

// #summary
export function summary(article: HelpCenterArticle) {
  const category = helpCenterData().categories.find((candidate) => candidate.id === article.category_id) ?? null;
  return { slug: article.slug, title: article.title, description: article.description, category: category?.title ?? null, audience: category?.audience ?? null, url: articleUrl(article) };
}

// #index
export const index = () => helpCenterData().articles.map(summary);

// #search: every meaningful word of the query must match, the headline hits leading.
export function search(query: string) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return index();
  const meaningful = words.filter((word) => !STOPWORDS.has(word));
  const terms = meaningful.length === 0 ? words : meaningful;
  const headline: ReturnType<typeof summary>[] = [];
  const body: ReturnType<typeof summary>[] = [];
  for (const article of helpCenterData().articles) {
    const heading = `${article.title} ${article.description}`.toLowerCase();
    if (terms.every((term) => heading.includes(term))) {
      headline.push(summary(article));
      continue;
    }
    const full = `${heading} ${plainText(article).toLowerCase()}`;
    if (terms.every((term) => full.includes(term))) body.push(summary(article));
  }
  return [...headline, ...body];
}
