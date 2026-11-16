// Port of HelpCenterPresenter and the HelpCenter::Category / HelpCenter::Article ActiveYaml models.
// The YAML under app/models/help_center stays the single source until Rails is removed.
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import * as Routes from "@/lib/navigation/routes";

import { type ArticleRenderOptions, renderArticleContent } from "./help-center-erb.ts";

export type HelpCenterCategory = { id: number; title: string; slug: string; audience: string };
export type HelpCenterArticle = { id: number; title: string; slug: string; description: string; category_id: number };

const DATA_DIR = path.join(process.cwd(), "..", "app", "models", "help_center");

// ActiveHash::Enum `enum_accessor :title` constant naming.
export function enumConstant(title: string): string {
  return title.replace(/\W+/gu, "_").replace(/^_|_$/gu, "").toUpperCase();
}

function loadYaml<T>(file: string, erb: (source: string) => string = (source) => source): T[] {
  return parse(erb(readFileSync(path.join(DATA_DIR, file), "utf8"))) as T[];
}

let cache: { categories: HelpCenterCategory[]; articles: HelpCenterArticle[] } | null = null;

export function helpCenterData() {
  if (cache) return cache;
  const categories = loadYaml<HelpCenterCategory>("categories.yml");
  const idsByConstant = new Map(categories.map((category) => [enumConstant(category.title), category.id]));
  // articles.yml is ERB; its only tags are `<%= HelpCenter::Category::CONSTANT.id %>`.
  const articles = loadYaml<HelpCenterArticle>("articles.yml", (source) =>
    source.replace(/<%=\s*HelpCenter::Category::(\w+)\.id\s*%>/gu, (_, constant: string) => {
      const id = idsByConstant.get(constant);
      if (id === undefined) throw new Error(`Unknown help center category constant ${constant}`);
      return String(id);
    }),
  );
  cache = { categories, articles };
  return cache;
}

export function findCategoryBySlug(slug: string): HelpCenterCategory | null {
  return helpCenterData().categories.find((category) => category.slug === slug) ?? null;
}

const articleLink = (article: HelpCenterArticle) => ({ title: article.title, url: Routes.help_center_article_path(article.slug) });

const categoryData = (category: HelpCenterCategory) => ({
  title: category.title,
  slug: category.slug,
  url: Routes.help_center_category_path(category.slug),
});

// HelpCenterPresenter#category_props
export function categoryProps(category: HelpCenterCategory) {
  const { categories, articles } = helpCenterData();
  return {
    category: {
      title: category.title,
      slug: category.slug,
      articles: articles.filter((article) => article.category_id === category.id).map(articleLink),
    },
    sidebar_categories: categories.filter((other) => other.audience === category.audience).map(categoryData),
  };
}

export function findArticleBySlug(slug: string): HelpCenterArticle | null {
  return helpCenterData().articles.find((article) => article.slug === slug) ?? null;
}

const sameAudience = (category: HelpCenterCategory) =>
  helpCenterData()
    .categories.filter((other) => other.audience === category.audience)
    .map(categoryData);

// HelpCenterPresenter#index_props
export function indexProps() {
  const { categories, articles } = helpCenterData();
  return {
    categories: categories.map((category) => ({
      title: category.title,
      url: Routes.help_center_category_path(category.slug),
      audience: category.audience,
      articles: articles.filter((article) => article.category_id === category.id).map(articleLink),
    })),
  };
}

// HelpCenterPresenter#article_props
export function articleProps(article: HelpCenterArticle, render: ArticleRenderOptions) {
  const category = helpCenterData().categories.find((candidate) => candidate.id === article.category_id)!;
  return {
    article: {
      title: article.title,
      slug: article.slug,
      content: renderArticleContent(article.slug, render),
      category: categoryData(category),
    },
    sidebar_categories: sameAudience(category),
  };
}

// HelpCenter::ArticlesController::LEGACY_ARTICLE_REDIRECTS
export const LEGACY_ARTICLE_REDIRECTS: Record<string, string> = { "284-jobs-at-gumroad": "/about#jobs" };
