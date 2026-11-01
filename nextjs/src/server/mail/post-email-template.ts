// The email of a post, as PostSendgridApi and PostResendApi render it: app/views/posts/post_email.html.erb
// through premailer. The `{{...}}` tokens stay in the output, for the providers to substitute.
// What Node cannot reproduce throws PostEmailNotPortedError, and the caller hands the job back:
// code blocks (Rouge), upsells, embeds and buttons in the message, a seller profile other than the
// default one (its stylesheet is compiled by SassC), and any environment but production (the
// layout's banner).
import defaults from "./post-email-defaults.generated.json" with { type: "json" };
import { domainConfig } from "../infra/domain.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { autoLink } from "../html/rinku.ts";
import { cgiUnescapeHtml } from "../html/sanitizer.ts";
import { fragmentToHtml, html4Fragment } from "../html/loofah.ts";
import { type HtmlNode, setAttribute, textContent } from "../html/libxml2-tree.ts";
import { squish } from "../search/plaintext.ts";
import { entrypointStylesheetHrefs, loadEmailStylesheet } from "./stylesheet.ts";
import { customizedPremailer } from "./premailer/premailer.ts";
import { gumroadAddressFull, h, mailerUrl } from "./views.ts";

export class PostEmailNotPortedError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "NotPortedError";
  }
}

export type DefaultProfile = { font: string | null; background_color: string | null; highlight_color: string | null; border_radius: string | null; button_hover: string | null };

// `SellerProfile` after_initialize: a missing value takes its default.
export function isDefaultProfile(profile: DefaultProfile | null): boolean {
  if (profile === null) return true;
  const expected = defaults.profile;
  return (
    (profile.font ?? "ABC Favorit") === expected.font &&
    (profile.background_color ?? "#ffffff") === expected.background_color &&
    (profile.highlight_color ?? "#ff90e8") === expected.highlight_color &&
    (profile.border_radius ?? "small") === expected.border_radius &&
    (profile.button_hover ?? "lift") === expected.button_hover
  );
}

// Loofah's :newline_block_elements: these elements, and <br>, are surrounded by newlines.
const LINEBREAKERS = new Set([
  "address", "blockquote", "center", "dir", "div", "dl", "fieldset", "form", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "isindex", "menu", "noframes", "noscript", "ol", "p", "pre", "table", "ul", "article", "aside", "canvas", "dd", "dt",
  "figcaption", "figure", "footer", "header", "hgroup", "li", "main", "nav", "output", "section", "tfoot", "video",
  "frameset", "tbody", "td", "th", "thead", "tr", "br",
]);

function loofahText(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "comment" || node.type === "pi") return "";
      if (node.type !== "element") return textContent(node);
      if (LINEBREAKERS.has(node.name)) return node.name === "br" ? "\n" : `\n${textContent(node)}\n`;
      return loofahText(node.children);
    })
    .join("");
}

// ActiveSupport String#truncate(255): the first 252 characters and "...".
const TRUNCATE_AT = 255;
function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= TRUNCATE_AT ? text : `${chars.slice(0, TRUNCATE_AT - 3).join("")}...`;
}

// Installment#truncated_description, then CGI.unescapeHTML as the view applies it. Loofah's `to_text`
// encodes &, < and > before the text is squished and truncated.
export function preheaderText(message: string | null): string {
  const text = loofahText(html4Fragment(message ?? "").children);
  const encoded = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return cgiUnescapeHtml(truncate(squish(squish(encoded))));
}

// Installment#message_with_inline_syntax_highlighting_and_upsells, for a message that has none of the
// elements it rewrites.
const REWRITTEN = /<pre|<upsell-card|tiptap__raw|tiptap__button|<body|<html/iu;
export function plainMessage(message: string | null): string {
  if (message === null) throw new PostEmailNotPortedError("a post without a message");
  if (message === "" || /^[\t\n\v\f\r ]*$/u.test(message)) return message;
  if (REWRITTEN.test(message)) throw new PostEmailNotPortedError("a message with code blocks, upsells, embeds, buttons or a document tag");
  return fragmentToHtml(html4Fragment(message));
}

// InstallmentsHelper#with_per_block_text_direction
const AUTO_DIRECTION_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote"]);
export function withPerBlockTextDirection(html: string): string {
  if (/^[\t\n\v\f\r ]*$/u.test(html)) return html;
  const fragment = html4Fragment(html);
  for (const node of fragment.children) {
    if (node.type !== "element" || !AUTO_DIRECTION_BLOCK_TAGS.has(node.name)) continue;
    const dir = node.attributes.find((attribute) => attribute.name === "dir");
    if (dir?.value != null && !/^[\t\n\v\f\r ]*$/u.test(dir.value)) continue;
    setAttribute(node, "dir", "auto");
  }
  return fragmentToHtml(fragment);
}

// `Rinku.auto_link(message, :all, %(target="_blank" rel="nofollow"))`
const MESSAGE_LINK_ATTRIBUTES = 'target="_blank" rel="nofollow"';

export type PostEmailView = {
  // post.subject
  subject: string;
  message: string | null;
  callToActionUrl: string | null;
  callToActionText: string | null;
  hasPostUrl: boolean;
  hasDownloadButton: boolean;
  hasCommentButton: boolean;
  hasSellerUpdateReason: boolean;
  profile: DefaultProfile | null;
};

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && !/^[\t\n\v\f\r ]*$/u.test(value);

// `content_tag(:span, ...)` / `link_to(..., "{{post_url}}", target: "_blank", class: "title")`
function postTitle(view: PostEmailView): string {
  return view.hasPostUrl ? `<a target="_blank" class="title" href="{{post_url}}">${h(view.subject)}</a>` : `<span class="title">${h(view.subject)}</span>`;
}

// layouts/mailers/_header_section.html.erb without a subheading
const headerSectionHtml = (heading: string) => `<div>\n  <h2>${heading}</h2>\n  \n</div>\n`;

// shared/_preheader_text.html.erb
function preheader(text: string): string {
  const maxLength = 250;
  const length = [...text].length;
  const padding = length >= maxLength ? 1 : maxLength - length;
  return `<div style="display:none;max-height:0;overflow:hidden">\n  ${h(text)}\n</div>\n<div style="display:none;max-height:0;overflow:hidden">\n  ${"&#847; ".repeat(padding)}\n</div>\n`;
}

// posts/post_email.html.erb
export function postEmailHtml(view: PostEmailView): string {
  if (railsEnv() !== "production") throw new PostEmailNotPortedError(`the post email outside production (${railsEnv()})`);
  if (!isDefaultProfile(view.profile)) throw new PostEmailNotPortedError("a seller profile other than the default one");
  const message = withPerBlockTextDirection(autoLink(plainMessage(view.message), MESSAGE_LINK_ATTRIBUTES));
  const buttonStyle = defaults.email_primary_button_style;
  const stylesheets = entrypointStylesheetHrefs("email")
    .map((href) => `<link rel="stylesheet" href="${h(href)}" />`)
    .join("\n");
  const header = headerSectionHtml(postTitle(view));
  const callToAction = present(view.callToActionUrl)
    ? `            <p>\n              <a class="button accent" href="${h(view.callToActionUrl)}" target="_blank">${h(view.callToActionText)}</a>\n            </p>\n`
    : "";
  const downloadButton = view.hasDownloadButton
    ? `          <div>\n            <p>\n              <a class="button primary" href="{{download_url}}" style="${h(buttonStyle)}">{{t_view_attachments_prompt}}</a>\n            </p>\n          </div>\n`
    : "";
  const commentButton = view.hasCommentButton
    ? `          <div>\n            <p>\n              <a class="button primary" href="{{post_url}}#comments" target="_blank" style="${h(buttonStyle)}">{{t_post_a_comment}}</a>\n            </p>\n          </div>\n`
    : "";
  const sellerUpdateReason = view.hasSellerUpdateReason ? "\n              {{seller_update_reason}}" : "";
  const assetHost = domainConfig().assetHost ?? "";
  const html = `<!-- IMPORTANT:
Do not include route helpers (\`root_url\`), because the URL options (e.g. the hostname) won't be correct. -->
<!DOCTYPE html>
<html>
  <head>
    <title>{{subject}}</title>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
    <meta name="viewport" content="initial-scale = 1.0, width=device-width">
    <style>${defaults.custom_styles}</style>
    ${stylesheets}
  </head>
  <body>
    <div class="email post">
      <div class="main">
        ${preheader(preheaderText(view.message))}
          ${header}

        <div class="rich-text" dir="auto">
          ${message}

${callToAction}        </div>

${downloadButton}
${commentButton}      </div>

      <div class="footer">
        <div class="paragraphs">
          <p>${sellerUpdateReason}
            <a href="{{unsubscribe_url}}">{{t_unsubscribe}}</a>
          </p>

          <p>${h(gumroadAddressFull())}</p>
        </div>

        <a class="wordmark" href="${h(mailerUrl("/"))}">
          {{t_powered_by}}
          <img src="${h(`${assetHost}/images/${defaults.email_wordmark_image_path}`)}" alt="Gumroad" style="width: 138px; height: 18px;" width="138" height="18">
        </a>
      </div>
    </div>
  </body>
</html>
`;
  return html;
}

export type RenderedPostEmail = { html: string; plaintext: string };

// ApplicationController.renderer.render(template: "posts/post_email", layout: false) through
// Premailer::Rails::CustomizedPremailer: `to_inline_css`, then `to_plain_text` of the document it
// inlined (a `<br>` that gained a style attribute is no longer a line break there).
export function renderPostEmail(view: PostEmailView): RenderedPostEmail {
  const premailer = customizedPremailer(postEmailHtml(view), loadEmailStylesheet);
  const html = premailer.toInlineCss();
  return { html, plaintext: premailer.toPlainText() };
}
