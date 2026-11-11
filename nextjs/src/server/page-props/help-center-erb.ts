// Renders app/views/help_center/articles/contents/_<slug>.html.erb, the partial HelpCenter::Article
// resolves through to_partial_path. The templates are plain HTML with a handful of `<%= %>` tags, so
// this evaluates exactly those (image_tag, image_path, link_to, dpa_url, churn_dashboard_path and one
// constant) and throws on anything else, rather than guessing.
import { readFileSync } from "node:fs";
import path from "node:path";

const RAILS_ROOT = path.join(process.cwd(), "..");
const CONTENTS_DIR = path.join(RAILS_ROOT, "app", "views", "help_center", "articles", "contents");
const CONSTANT_SOURCES: Record<string, { file: string; name: string }> = {
  "RetryStripeRejectedPayoutSetupsJob::RETRY_WINDOW_WEEKS": {
    file: path.join(RAILS_ROOT, "app", "sidekiq", "retry_stripe_rejected_payout_setups_job.rb"),
    name: "RETRY_WINDOW_WEEKS",
  },
};

export type ArticleRenderOptions = {
  // ApplicationController#default_url_options, for `*_url` helpers.
  urlOptions: { protocol: string; host: string };
  // config.asset_host (null in test): image_path/image_tag prefix public assets with it.
  assetHost: string | null;
};

// A value ERB writes as is, because the helper that built it already escaped it (ActiveSupport::SafeBuffer).
class SafeString {
  constructor(readonly value: string) {}
}

type Value = string | number | SafeString | Kwargs;
type Kwargs = { [key: string]: string | number };

// ERB::Util.html_escape
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]!);

type Token = { type: "string" | "number" | "ident" | "label" | "punct"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|(\d+)|([A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*)(:)?|([(),]))/yu;
  let rest = 0;
  while (rest < source.length) {
    pattern.lastIndex = rest;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unsupported ERB expression: ${source}`);
    if (match[1] !== undefined) tokens.push({ type: "string", value: match[1].replace(/\\(.)/gu, "$1") });
    else if (match[2] !== undefined) tokens.push({ type: "number", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: match[4] ? "label" : "ident", value: match[3] });
    else tokens.push({ type: "punct", value: match[5]! });
    rest = pattern.lastIndex;
    if (/^\s*$/u.test(source.slice(rest))) break;
  }
  return tokens;
}

class Evaluator {
  private position = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly options: ArticleRenderOptions,
    private readonly source: string,
  ) {}

  run(): Value {
    const value = this.expression();
    if (this.position !== this.tokens.length) throw new Error(`Unsupported ERB expression: ${this.source}`);
    return value;
  }

  private peek = () => this.tokens[this.position];

  private expression(): Value {
    const token = this.tokens[this.position++];
    if (!token) throw new Error(`Unsupported ERB expression: ${this.source}`);
    if (token.type === "string") return token.value;
    if (token.type === "number") return Number(token.value);
    if (token.type !== "ident") throw new Error(`Unsupported ERB expression: ${this.source}`);
    return this.call(token.value, this.arguments());
  }

  // `name(a, b, key: c)` or `name a, b, key: c`; a bare identifier takes none.
  private arguments(): { positional: Value[]; keywords: Kwargs } {
    const positional: Value[] = [];
    const keywords: Kwargs = {};
    const parenthesised = this.peek()?.value === "(" && this.peek()?.type === "punct";
    if (parenthesised) this.position++;
    const next = this.peek();
    const hasArguments = next !== undefined && !(next.type === "punct" && next.value === ")");
    if (hasArguments && (parenthesised || next.type !== "punct")) {
      for (;;) {
        const token = this.peek();
        if (token?.type === "label") {
          this.position++;
          const value = this.expression();
          if (typeof value === "object") throw new Error(`Unsupported ERB expression: ${this.source}`);
          keywords[token.value] = value;
        } else positional.push(this.expression());
        if (this.peek()?.value === "," && this.peek()?.type === "punct") this.position++;
        else break;
      }
    }
    if (parenthesised) {
      if (this.peek()?.value !== ")") throw new Error(`Unsupported ERB expression: ${this.source}`);
      this.position++;
    }
    return { positional, keywords };
  }

  private call(name: string, { positional, keywords }: { positional: Value[]; keywords: Kwargs }): Value {
    const { urlOptions, assetHost } = this.options;
    const text = (value: Value | undefined) => (value instanceof SafeString ? value.value : typeof value === "object" || value === undefined ? "" : String(value));
    switch (name) {
      case "image_path":
        return imagePath(text(positional[0]), assetHost);
      case "image_tag": {
        // Options keep their order and src comes last (ActionView::Helpers::AssetTagHelper#image_tag).
        const attributes = Object.entries({ ...keywords, src: imagePath(text(positional[0]), assetHost) });
        return new SafeString(`<img ${attributes.map(([key, value]) => `${key}="${escape(String(value))}"`).join(" ")} />`);
      }
      case "link_to":
        return new SafeString(`<a href="${escape(text(positional[1]))}">${escape(text(positional[0]))}</a>`);
      case "dpa_url":
        return `${urlOptions.protocol}://${urlOptions.host}/dpa`;
      case "churn_dashboard_path":
        return "/dashboard/churn";
      default: {
        const constant = CONSTANT_SOURCES[name];
        if (!constant) throw new Error(`Unsupported ERB expression: ${this.source}`);
        const match = new RegExp(`${constant.name}\\s*=\\s*(\\d+)`).exec(readFileSync(constant.file, "utf8"));
        if (!match) throw new Error(`Cannot read ${name}`);
        return Number(match[1]);
      }
    }
  }
}

// ActionView asset path for public/ files: URLs and absolute paths are left alone.
function imagePath(source: string, assetHost: string | null): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(source)) return source;
  return `${assetHost ?? ""}/images/${source}`;
}

const templates = new Map<string, string>();

export function renderArticleContent(slug: string, options: ArticleRenderOptions): string {
  let template = templates.get(slug);
  if (template === undefined) {
    template = readFileSync(path.join(CONTENTS_DIR, `_${slug}.html.erb`), "utf8");
    templates.set(slug, template);
  }
  return template.replace(/<%=\s*([\s\S]*?)\s*%>/gu, (_, expression: string) => {
    const value = new Evaluator(tokenize(expression), options, expression).run();
    return value instanceof SafeString ? value.value : escape(String(value));
  });
}
