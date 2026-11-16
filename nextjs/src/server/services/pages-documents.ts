// Port of Pages::DocumentTitle and Pages::RichTextDocument (app/services/pages): the title and the standalone document of a seller's
// slugged rich text page. Goldens come from nextjs/scripts/golden/custom-html-document.rb.
import { escapeHtml } from "../controllers/custom-html-document.ts";

// String#strip: ASCII white space and NUL
const strip = (text: string): string => text.replace(/^[\0\t-\r ]+|[\0\t-\r ]+$/gu, "");
// String#present?: not blank, where blank is Unicode white space only
const present = (text: string | null | undefined): text is string => text != null && !/^\p{White_Space}*$/u.test(text);

// Pages::DocumentTitle.for
export function documentTitleFor(options: {
  pageTitle: string | null;
  sellerName: string | null;
  seoTitle?: string | null;
}): string {
  if (present(options.seoTitle)) return options.seoTitle;
  const title = options.pageTitle ?? "";
  const seller = strip(options.sellerName ?? "");
  if (seller === "" || strip(title).toLowerCase().endsWith(seller.toLowerCase())) return title;
  if (strip(title) === "") return seller;
  return `${title} — ${seller}`;
}

// Pages::RichTextDocument.render
export function richTextDocument(options: {
  page: { title: string | null; seo_title: string | null; content: string | null };
  sellerName: string | null;
  profileHref: string;
  headExtra: string;
}): string {
  const { page, sellerName, profileHref, headExtra } = options;
  const title = escapeHtml(page.title ?? "");
  const seller = escapeHtml(sellerName ?? "");
  const documentTitle = escapeHtml(documentTitleFor({ pageTitle: page.title, sellerName, seoTitle: page.seo_title }));
  const href = escapeHtml(profileHref);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${documentTitle}</title>`,
    `    ${headExtra}`,
    "    <style>",
    "      :root { color-scheme: light dark; }",
    '      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; background: #fff; color: #000; }',
    "      main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.5rem; }",
    "      header a { font-size: 0.875rem; color: inherit; }",
    "      h1.page-title { margin: 0.5rem 0 2rem; font-size: 2rem; line-height: 1.2; }",
    "      article img { max-width: 100%; height: auto; }",
    "      article pre { overflow-x: auto; padding: 1rem; background: rgba(127, 127, 127, 0.1); border-radius: 4px; }",
    "      article blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid currentColor; opacity: 0.8; }",
    "      article table { border-collapse: collapse; }",
    "      article th, article td { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.4rem 0.6rem; }",
    "      article a.tiptap__button { display: inline-block; margin: 0.25rem 0; padding: 0.6rem 1rem; background: #ff90e8; color: #000; text-decoration: none; border: 1px solid #000; border-radius: 4px; box-shadow: 0.25rem 0.25rem 0 #000; }",
    "      @media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }",
    "    </style>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <header>",
    `        <a href="${href}">${seller}</a>`,
    `        <h1 class="page-title">${title}</h1>`,
    "      </header>",
    `      <article>${page.content ?? ""}</article>`,
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}
