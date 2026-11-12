// Port of app/views/layouts/home.html.erb and layouts/application.html.erb with their head partial (the flash partial renders nothing: pages with a flash hand back), and of the
// home/shared partials the pages share (nav, header, button, how_we_build, scripts, footer). Whitespace is Erubi's: a `<% %>` line
// disappears with its newline, a `<%= %>` keeps the indentation in front of it and the newline after it.
//
// The nav, header, button and how_we_build partials hold Ruby (methods, hashes, string interpolation), so they are written out
// here; the footer and the scripts are plain markup and are read from the .erb files Rails renders.
import { storageConfig } from "../infra/storage.ts";
import { viteEntrypointStylesheet, viteTypescriptTag } from "../infra/vite.ts";
import { assetHost, type DomainConfig } from "../page-props/domain.ts";
import { type MetaTagBuilder } from "../page-props/meta-tags.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import {
  type Attributes,
  buttonTag,
  contentTag,
  escapeHtml,
  html,
  type Html,
  imageTag,
  linkTo,
  SafeString,
} from "./html.ts";
import { type ErbTable, type Helpers, readView, renderErb } from "./template.ts";

export type LayoutContext = {
  config: DomainConfig;
  // request.path and request.headers["User-Agent"].
  path: string;
  method: string;
  userAgent: string | null;
  // params[:as_embed] is truthy
  asEmbed: boolean;
  // session["flash"] of the request: alert, warning, info and notice are read.
  flash: Record<string, string>;
  nonce: string;
  meta: MetaTagBuilder;
  // GithubStarsController.cached_count
  githubStars: number | null;
  signedIn: boolean;
  hideLayouts: boolean;
  bodyClass?: string;
};

// config/routes.rb paths the home pages link to.
export const PATHS: Record<string, string> = {
  discover_path: "/discover",
  gumroad_blog_root_path: "/blog",
  pricing_path: "/pricing",
  features_path: "/features",
  about_path: "/about",
  gumclaw_path: "/gumclaw",
  small_bets_path: "/small-bets",
  mcp_path: "/mcp",
  help_center_root_path: "/help",
  settings_authorized_applications_path: "/settings/authorized_applications",
  prohibited_path: "/prohibited",
  terms_path: "/terms",
  privacy_path: "/privacy",
  login_path: "/login",
  signup_path: "/signup",
  root_path: "/",
};

export const imagePath = (config: DomainConfig, source: string) =>
  /^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(source) ? source : `${assetHost(config) ?? ""}/images/${source}`;

// ActiveSupport's number_to_human as ApplicationHelper#number_to_si calls it (precision 1, truncated, trailing zero stripped).
const SI_UNITS = ["", "K", "M", "B", "T"];
export function numberToSi(number: number): string {
  if (!Number.isSafeInteger(number) || number < 0) throw new NotPortedError(`number_to_si of ${number}`);
  let unit = 0;
  while (number >= 10 ** (3 * (unit + 1)) && unit < SI_UNITS.length - 1) unit++;
  if (number >= 10 ** (3 * SI_UNITS.length)) throw new NotPortedError(`number_to_si of ${number}`);
  if (unit === 0) return String(number);
  const tenths = Math.floor(number / 10 ** (3 * unit - 1));
  const fraction = tenths % 10;
  return `${Math.floor(tenths / 10)}${fraction === 0 ? "" : `.${fraction}`}${SI_UNITS[unit]}`;
}

// home/shared/_button.html.erb
const BUTTON_VARIANTS: Record<string, string> = {
  light: "bg-black text-white dark:bg-pink dark:text-black",
  dark: "bg-white text-black",
  pink: "bg-pink text-black",
};
const BUTTON_SIZES: Record<string, string> = {
  small: "h-12 px-3 text-base lg:h-12 lg:px-6 lg:text-base",
  default: "h-14 px-8 text-xl lg:h-16 lg:px-10 lg:text-xl",
};

export function button(options: { text: string; url: string; type?: string; variant?: string; size?: string }): string {
  const variant = BUTTON_VARIANTS[options.variant ?? "light"];
  const size = BUTTON_SIZES[options.size ?? "default"];
  if (variant === undefined || size === undefined) throw new NotPortedError("a button variant or size");
  const classes = `relative inline-flex rounded-sm no-underline items-center justify-center border border-black transition-all duration-150 group-hover:-translate-x-2 group-hover:-translate-y-2 z-3 w-full lg:w-auto cursor-pointer ${size} ${variant}`;
  const inner =
    options.type === "submit"
      ? buttonTag(new SafeString(`\n      ${escapeHtml(options.text)}\n`), { type: "submit", class: classes })
      : linkTo(new SafeString(`\n      ${escapeHtml(options.text)}\n`), options.url, { class: classes });
  return `\n<div class="relative inline-block group">
  <div class="absolute inset-0 rounded-sm bg-yellow border border-black transition-transform duration-150 z-2"></div>
  <div class="absolute inset-0 rounded-sm bg-red border border-black transition-transform duration-150 group-hover:translate-x-2 group-hover:translate-y-2 z-1"></div>
    ${html(inner)}</div>\n`;
}

// home/shared/_header.html.erb: `title`, `subtitle` and `description` are written raw (`<%==`); `content` is the block's output.
export function header(options: {
  bgColor: string;
  textColor?: string;
  subtitle?: string;
  title?: string;
  description?: string;
  noBorder?: boolean;
  gap?: string;
  darkBgColor?: string;
  content: string;
}): string {
  const gapClass = options.gap ?? "gap-20";
  const borderClass = options.noBorder ? "" : "border-b border-black dark:border-white/35";
  const bgClass = options.darkBgColor
    ? `bg-${options.bgColor} dark:bg-${options.darkBgColor}`
    : `bg-${options.bgColor}`;
  const textColorClass = options.textColor
    ? `text-${options.textColor}`
    : options.darkBgColor
      ? "text-black dark:text-white"
      : "text-black dark:text-black";
  const present = (value: string | undefined) => value !== undefined && value.trim() !== "";
  return `<header class="relative flex flex-col items-center justify-center h-auto ${borderClass} ${bgClass} text-center ${gapClass} px-8 pt-16 pb-20 md:pt-20 md:pb-24 lg:pt-28 lg:pb-36 ${textColorClass}">
  <div class="flex flex-col max-w-2xl gap-8 lg:gap-10 lg:max-w-3xl">
${present(options.subtitle) ? `      <div class="text-xl md:text-2xl">${options.subtitle}</div>\n` : ""}${present(options.title) ? `      <h1 class="text-5xl font-medium md:text-6xl md:leading-[0.9] lg:text-8xl">${options.title}</h1>\n` : ""}${present(options.description) ? `      <div class="text-xl md:text-2xl">${options.description}</div>\n` : ""}  </div>
  ${options.content}
</header>
`;
}

// home/shared/_how_we_build.html.erb
export type Card = { icon: string; iconBg: string; title: string; description: string };
export function howWeBuild(config: DomainConfig, cards: Card[]): string {
  const rows = cards
    .map(
      (card) => `      <div class="relative">
        <div class="absolute -top-8 sm:-top-10 left-6 w-16 h-16 sm:w-20 sm:h-20 rounded-xl flex items-center justify-center border-2 border-black dark:border-white/35 bg-${card.iconBg} shadow-[4px_4px_0_0_#000] dark:shadow-[4px_4px_0_0_rgba(255,255,255,0.35)]">
          ${html(imageTag(imagePath(config, card.icon), { alt: card.title, class: "w-12 h-12" }))}
        </div>
        <div class="bg-white dark:bg-dark-gray text-black dark:text-white rounded-2xl p-8 pt-12 sm:pt-14 h-full">
          <h3 class="text-xl sm:text-2xl font-bold mb-2 sm:mb-4">${escapeHtml(card.title)}</h3>
          <p class="text-base sm:text-lg">${escapeHtml(card.description)}</p>
        </div>
      </div>
`,
    )
    .join("");
  return `\n<div class="mx-auto max-w-7xl px-8 md:px-none">
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10 gap-y-16 md:gap-y-20">
${rows}  </div>
</div>
`;
}

// The home/shared partials that take locals. Their markup is read from the .erb file; the table is the Ruby in them, written out.
const hashOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !(value instanceof SafeString)
    ? (value as Record<string, unknown>)
    : {};
const required = (keywords: Record<string, unknown>, key: string): string => {
  const value = keywords[key];
  if (typeof value !== "string") throw new NotPortedError(`the partial local ${key}`);
  return value;
};

// `<%== local %>` is written raw.
function sectionHeader(config: DomainConfig, keywords: Record<string, unknown>): string {
  const raw = {
    subtitle: required(keywords, "subtitle"),
    title: required(keywords, "title"),
    description: required(keywords, "description"),
  };
  return renderErb("home/shared/_section_header.html.erb", {
    values: {
      "= subtitle": () => new SafeString(raw.subtitle),
      "= title": () => new SafeString(raw.title),
      "= description": () => new SafeString(raw.description),
    },
    helpers: homeHelpers(config),
  });
}

const SECTION_CTA_LOCALS = `title = local_assigns[:title] || "Share your work. <br> Someone out there needs it."
  button_text = local_assigns[:button_text] || "Start selling"
  button_url = local_assigns[:button_url] || signup_path`;
function sectionCta(config: DomainConfig, keywords: Record<string, unknown>): string {
  const local = (key: string, fallback: string) =>
    typeof keywords[key] === "string" ? String(keywords[key]) : fallback;
  const title = local("title", "Share your work. <br> Someone out there needs it.");
  const buttonText = local("button_text", "Start selling");
  const buttonUrl = local("button_url", PATHS.signup_path!);
  return renderErb("home/shared/_section_cta.html.erb", {
    statements: { [SECTION_CTA_LOCALS]: () => undefined },
    values: {
      "= title": () => new SafeString(title),
      'render "home/shared/button", text: button_text, url: button_url, variant: "dark"': () =>
        new SafeString(button({ text: buttonText, url: buttonUrl, variant: "dark" })),
    },
    helpers: homeHelpers(config),
  });
}

function accordionItem(locals: Record<string, unknown>): string {
  const title = required(locals, "title");
  const content = required(locals, "content");
  return renderErb("home/shared/_accordion_item.html.erb", {
    values: { title: () => title, "content.html_safe": () => new SafeString(content) },
  });
}

function reviewCard(locals: Record<string, unknown>, block: SafeString): string {
  const name = required(locals, "name");
  return renderErb("home/shared/_review_card.html.erb", { values: { yield: () => block, name: () => name } });
}

// `<%= javascript_tag nonce: SecureHeaders.content_security_policy_script_nonce(request), data: { cfasync: "false" } do %>`:
// JavaScriptHelper#javascript_tag wraps the block in a CDATA section.
const JAVASCRIPT_TAG =
  'javascript_tag nonce: SecureHeaders.content_security_policy_script_nonce(request), data: { cfasync: "false" }';
export const scriptBlocks = (nonce: string): NonNullable<ErbTable["blocks"]> => ({
  [JAVASCRIPT_TAG]: (_scope, body) =>
    new SafeString(`<script nonce="${nonce}" data-cfasync="false">\n//<![CDATA[\n${body.value}\n//]]>\n</script>`),
});
function scriptPartial(file: string, nonce: string | undefined): string {
  if (nonce === undefined) throw new NotPortedError(`${file} without a CSP nonce`);
  return renderErb(file, { blocks: scriptBlocks(nonce) });
}

// ActionView's `number_with_delimiter` for an Integer.
const withDelimiter = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

// home/shared/_testimonial.html.erb: the locals are the scope, so the file's own expressions evaluate.
function testimonial(config: DomainConfig, locals: Record<string, unknown>): string {
  return renderErb("home/shared/_testimonial.html.erb", { helpers: homeHelpers(config) }, locals);
}

// home/shared/_discovery_category.html.erb: the rows are literals in the file; only `row[:tags] * 2` is written out.
function discoveryCategory(config: DomainConfig): string {
  return renderErb("home/shared/_discovery_category.html.erb", {
    helpers: homeHelpers(config),
    loops: {
      "(row[:tags] * 2).each do |tag|": (scope) => {
        const tags = hashOf(scope.row).tags;
        if (!Array.isArray(tags)) throw new NotPortedError("the discovery rows");
        return [...tags, ...tags].map((tag) => ({ tag }));
      },
    },
  });
}

// url_for with a `host` and query keys: Hash#to_query sorts the keys and CGI.escape writes a space as `+`.
function taxonomyUrl(config: DomainConfig, taxonomy: string, options: Record<string, unknown>): string {
  const { host, ...query } = options;
  const pairs = Object.keys(query)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(query[key])).replaceAll("%20", "+")}`);
  return `${config.protocol}://${String(host)}/${taxonomy}${pairs.length > 0 ? `?${pairs.join("&")}` : ""}`;
}

function testimonialSlide(config: DomainConfig, keywords: Record<string, unknown>): string {
  const local = (key: string) => required(keywords, key);
  return renderErb("home/shared/_testimonial_slide.html.erb", {
    values: {
      image_url: () => local("image_url"),
      name: () => local("name"),
      profile_url: () => local("profile_url"),
      username: () => local("username"),
      quote: () => local("quote"),
      product_type: () => local("product_type"),
    },
    helpers: homeHelpers(config),
  });
}

// The helpers the home views call with literal arguments. `nonce` is the page's CSP script nonce.
export function homeHelpers(config: DomainConfig, nonce?: string): Helpers {
  return {
    render: ({ positional, keywords, block }) => {
      const partial = positional[0] ?? keywords.partial ?? keywords.layout;
      const locals = hashOf(keywords.locals);
      switch (partial) {
        case "home/shared/footer":
          return new SafeString(footer(config));
        case "home/shared/header": {
          const text = (key: string) => (typeof keywords[key] === "string" ? String(keywords[key]) : undefined);
          return new SafeString(
            header({
              bgColor: String(keywords.bg_color),
              textColor: text("text_color"),
              subtitle: text("subtitle"),
              title: text("title"),
              description: text("description"),
              noBorder: keywords.no_border === true,
              gap: text("gap"),
              darkBgColor: text("dark_bg_color"),
              content: block?.value ?? "",
            }),
          );
        }
        case "home/shared/section_header":
          return new SafeString(sectionHeader(config, keywords));
        case "home/shared/section_cta":
          return new SafeString(sectionCta(config, keywords));
        case "home/shared/testimonial_slide":
          return new SafeString(testimonialSlide(config, keywords));
        case "home/shared/carousel":
          return new SafeString(scriptPartial("home/shared/_carousel.html.erb", nonce));
        case "home/shared/hero_parallax":
          return new SafeString(scriptPartial("home/shared/_hero_parallax.html.erb", nonce));
        case "home/shared/testimonial":
          return new SafeString(testimonial(config, keywords));
        case "home/shared/discovery_category":
          return new SafeString(discoveryCategory(config));
        case "home/shared/accordion_item":
          return new SafeString(accordionItem(locals));
        case "home/shared/review_card":
          if (!block) throw new NotPortedError("the review card without a block");
          return new SafeString(reviewCard(locals, block));
        case "home/shared/button":
          return new SafeString(
            button({
              text: String(keywords.text),
              url: String(keywords.url),
              ...(keywords.variant ? { variant: String(keywords.variant) } : {}),
              ...(keywords.type ? { type: String(keywords.type) } : {}),
              ...(keywords.size ? { size: String(keywords.size) } : {}),
            }),
          );
        default:
          throw new NotPortedError(`the partial ${String(partial)}`);
      }
    },
    image_tag: ({ positional, keywords }) => imageTag(imagePath(config, String(positional[0])), keywords as Attributes),
    link_to: ({ positional, keywords }) => linkTo(String(positional[0]), String(positional[1]), keywords as Attributes),
    DISCOVER_DOMAIN: () => config.discoverDomain,
    discover_taxonomy_url: ({ positional, keywords }) => taxonomyUrl(config, String(positional[0]), keywords),
    number_with_delimiter: ({ positional }) => {
      const [value] = positional;
      if (typeof value !== "number") throw new NotPortedError("number_with_delimiter of a non-integer");
      return withDelimiter(value);
    },
    image_path: ({ positional }) => imagePath(config, String(positional[0])),
    help_center_article_path: ({ positional }) => `/help/article/${String(positional[0])}`,
    ...Object.fromEntries(Object.entries(PATHS).map(([name, value]) => [name, () => value])),
  };
}

// home/shared/_footer.html.erb
export function footer(config: DomainConfig): string {
  return renderErb("home/shared/_footer.html.erb", { helpers: homeHelpers(config) });
}

// home/shared/_scripts.html.erb: a `javascript_tag` around the file's own script, then the Lottie player.
export function scripts(nonce: string): string {
  const source = readView("home/shared/_scripts.html.erb");
  const open =
    /^<%= javascript_tag nonce: SecureHeaders\.content_security_policy_script_nonce\(request\), data: \{ cfasync: "false" \} do %>\n/u;
  const close = "<% end %>\n";
  const start = open.exec(source);
  const end = source.indexOf(close);
  if (!start || end < 0 || source.slice(end + close.length).includes("<%"))
    throw new NotPortedError("the shape of home/shared/_scripts.html.erb");
  const script = source.slice(start[0].length - 1, end);
  // JavaScriptHelper#javascript_tag: "\n//<![CDATA[\n" ... "\n//]]>\n" inside <script>.
  return `<script nonce="${nonce}" data-cfasync="false">\n//<![CDATA[\n${script}\n//]]>\n</script>${source.slice(end + close.length)}`;
}

// home/shared/_nav.html.erb for a signed-out visitor.
const NAV_LINK_BASE = "flex w-full items-center justify-center border";
function navLink(text: string, target: string, current: boolean): string {
  const classes = `${NAV_LINK_BASE} ${current ? "border-black" : "border-transparent"} ${
    current
      ? "lg:bg-black lg:text-white dark:lg:bg-white dark:lg:text-black"
      : "lg:bg-transparent lg:text-black dark:lg:text-white"
  } bg-black p-4 text-lg text-white no-underline transition-all duration-200 hover:border-black lg:w-auto lg:rounded-full lg:py-2 lg:px-4 dark:text-white lg:dark:hover:border-white/35 whitespace-nowrap`;
  return html(linkTo(text, target, { class: classes }));
}

function authButton(text: string, target: string, primary: boolean): string {
  // The Dashboard button is the primary one with its own colours, and none of the dark-mode set the other primary button adds.
  const dashboard = text === "Dashboard";
  const classes = `flex w-full items-center justify-center h-full ${
    dashboard
      ? "lg:bg-black lg:text-white lg:hover:bg-pink dark:lg:bg-pink dark:lg:text-black dark:lg:hover:bg-white"
      : primary
        ? "lg:bg-black lg:text-white lg:hover:bg-pink"
        : "lg:border-l-black lg:bg-white lg:text-black lg:hover:bg-pink dark:lg:border-l-white/35 dark:lg:bg-black dark:lg:text-white"
  } border-black bg-black p-4 text-lg text-white no-underline transition-colors duration-200 hover:bg-pink hover:text-black lg:w-auto lg:border-l lg:py-2 lg:px-6 whitespace-nowrap ${
    primary && !dashboard
      ? "dark:bg-pink dark:text-black dark:hover:bg-white dark:lg:bg-pink dark:lg:text-black dark:lg:hover:bg-white"
      : "dark:lg:hover:bg-white dark:lg:hover:text-black"
  }`;
  return html(linkTo(text, target, { class: classes }));
}

// ActionView's current_page?: GET or HEAD, the request path against the link's, ignoring a trailing slash.
function currentPage(ctx: LayoutContext, target: string): boolean {
  if (ctx.method !== "GET" && ctx.method !== "HEAD") return false;
  const chomp = (value: string) => (value !== "/" && value.endsWith("/") ? value.slice(0, -1) : value);
  return chomp(target) === chomp(decodeURIComponent(ctx.path));
}

export function nav(ctx: LayoutContext): string {
  const navLinks = html(
    contentTag(
      "div",
      new SafeString(
        [
          navLink("Discover", PATHS.discover_path!, currentPage(ctx, PATHS.discover_path!)),
          navLink(
            "Blog",
            PATHS.gumroad_blog_root_path!,
            currentPage(ctx, PATHS.gumroad_blog_root_path!) || ctx.path.startsWith(PATHS.gumroad_blog_root_path!),
          ),
          navLink("Pricing", PATHS.pricing_path!, currentPage(ctx, PATHS.pricing_path!)),
          navLink("Features", PATHS.features_path!, currentPage(ctx, PATHS.features_path!)),
          navLink(
            "About",
            PATHS.about_path!,
            currentPage(ctx, PATHS.about_path!) || currentPage(ctx, PATHS.root_path!),
          ),
          navLink(
            "Gumclaw",
            PATHS.gumclaw_path!,
            currentPage(ctx, PATHS.gumclaw_path!) || ctx.path.startsWith(PATHS.gumclaw_path!),
          ),
        ].join(""),
      ),
      { class: "flex flex-col justify-center items-center lg:flex-row lg:gap-1 lg:px-6" },
    ),
  );
  const authLinks = html(
    contentTag(
      "div",
      new SafeString(
        ctx.signedIn
          ? // dashboard_url(host: DOMAIN)
            authButton("Dashboard", `${ctx.config.protocol}://${ctx.config.domain}/dashboard`, true)
          : authButton("Log in", PATHS.login_path!, false) + authButton("Start selling", PATHS.signup_path!, true),
      ),
      { class: "flex flex-col lg:flex-row lg:h-full" },
    ),
  );
  const toggle = html(
    contentTag(
      "div",
      contentTag(
        "button",
        new SafeString(
          html(
            contentTag("div", "", {
              class: "mb-1 h-0.5 w-8 origin-center bg-black transition-transform duration-200 dark:bg-white",
              data: { menu_line: "1" },
            }),
          ) +
            html(
              contentTag("div", "", {
                class: "mt-1 h-0.5 w-8 origin-center bg-black transition-transform duration-200 dark:bg-white",
                data: { menu_line: "2" },
              }),
            ),
        ),
        {
          class: "relative flex h-8 w-8 flex-col all-unset items-center justify-center focus:outline-hidden",
          data: { toggle: "mobile-menu" },
        },
      ),
      { class: "flex items-center lg:hidden" },
    ),
  );
  const logo = html(
    linkTo(
      imageTag(imagePath(ctx.config, "logo.svg"), { loading: "lazy", alt: "", class: "h-7 lg:h-8 dark:invert" }),
      "/",
      { class: "flex items-center" },
    ),
  );
  return `\n<div class="justify-between bg-white border-b border-black top-0 left-0 right-0 z-50 pr-4 pl-4 h-20 sticky flex lg:pl-8 lg:pr-0 dark:bg-black dark:border-b-white/35">
  <div class="flex items-center gap-2">
    ${logo}

    ${githubStarsLink(ctx.githubStars)}  </div>

  <div class="override hidden lg:flex lg:items-center">
    ${navLinks}
    ${authLinks}
  </div>

  ${toggle}
</div>
<div class="override hidden justify-between border-b border-black flex-col top-20 left-0 right-0 z-50 fixed bg-black dark:border-white/35" id="mobile-menu">
  ${navLinks}
  ${authLinks}
</div>
`;
}

const GITHUB_ICON_PATH = readGithubIconPath();
function readGithubIconPath(): string {
  const match = /<svg width="20" height="20" viewBox="0 0 98 96"[\s\S]*?<\/svg>/u.exec(
    readView("home/shared/_nav.html.erb"),
  );
  if (!match) throw new NotPortedError("the GitHub icon of home/shared/_nav.html.erb");
  return match[0];
}

function githubStarsLink(stars: number | null): string {
  const icon = (width: number) =>
    new RegExp(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${width}"[\\s\\S]*?</svg>`,
      "u",
    ).exec(readView("home/shared/_nav.html.erb"))![0];
  const classes =
    "flex gap-1.5 rounded-full p-1.5 border border-black no-underline dark:border-white/35 hover:bg-gray-100 dark:hover:bg-gray-700 text-black dark:text-white hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[2px_2px_0_0_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0_0_rgba(255,255,255,0.35)] transition-all duration-100";
  // A star count GitHub failed to give (cached as nil) leaves the name and an arrow.
  const content =
    stars === null
      ? `
      ${GITHUB_ICON_PATH}
        <div class="flex items-center gap-1.5">
          <span class="text-base leading-none font-medium">GitHub</span>
          ${icon(14)}
        </div>
`
      : `
      ${GITHUB_ICON_PATH}
        <div class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="text-base leading-none font-medium">${numberToSi(stars)}</span>
          ${icon(18)}
        </div>
`;
  return html(
    linkTo(new SafeString(content), "https://github.com/antiwork/gumroad", {
      target: "_blank",
      rel: "noopener noreferrer",
      class: classes,
      aria: { label: "Visit Gumroad on GitHub" },
    }),
  );
}

const FLASH_STATUS_CLASSES: Record<string, string> = {
  danger: "border-danger bg-danger/20 text-danger",
  warning: "border-warning bg-warning/20 text-warning",
  info: "border-info bg-info/20 text-info",
  success: "border-success bg-success/20 text-success",
};

// layouts/shared/_flash.html.erb: the first of alert, warning, info and notice (an empty string is truthy in Ruby) as a toast that
// removes itself. What Erubi trims is the `<% %>` lines; the markup keeps the partial's own indentation.
function flashPartial(ctx: LayoutContext): string {
  const { flash } = ctx;
  const key = ["alert", "warning", "info", "notice"].find((name) => flash[name] !== undefined);
  if (key === undefined) return "";
  const status = key === "alert" ? "danger" : key === "warning" ? "warning" : key === "info" ? "info" : "success";
  return `    <div id="flash-toast"
         class="fixed top-4 left-1/2 z-100 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded bg-background md:max-w-sm"
         style="transition: all 0.3s ease-out 0.5s;">
      <div role="status" class="flex items-center gap-2 rounded border p-4 text-sm
        ${FLASH_STATUS_CLASSES[status]}">
        ${escapeHtml(flash[key]!)}
      </div>
    </div>
    <script nonce="${ctx.nonce}">
      setTimeout(function() {
        var el = document.getElementById("flash-toast");
        if (el) {
          el.style.transform = "translateX(-50%) translateY(calc(-100% - var(--spacer-4)))";
          setTimeout(function() { el.remove(); }, 900);
        }
      }, 5000);
    </script>
`;
}

// The line Erubi leaves where `<%= yield :style %>` or an empty vite tag was: its indentation and a newline.
const BLANK = "  \n";

// layouts/application/_head.html.erb
function head(ctx: LayoutContext): string {
  const { config } = ctx;
  const storage = storageConfig(config.railsEnv);
  const prefetch = (url: string | null | undefined) =>
    url ? `    <link rel="dns-prefetch" href="//${new URL(url).host}">\n` : "";
  const stylesheet = viteEntrypointStylesheet("entrypoints/design.scss");
  const assetHostUrl = assetHost(config);
  return `<head prefix="og: http://ogp.me/ns# fb: http://ogp.me/ns/fb# ${process.env.FACEBOOK_OG_NAMESPACE ?? ""}: http://ogp.me/ns/fb/${process.env.FACEBOOK_OG_NAMESPACE ?? ""}#">
${prefetch(assetHostUrl)}${prefetch(storage.cdnS3ProxyHost)}${prefetch(storage.publicStorageCdnS3ProxyHost)}  <meta name="action-cable-url" content="/cable" />
${BLANK}${BLANK}  ${stylesheet.tag}
${BLANK}${BLANK}  ${html(ctx.meta.toErb())}
</head>
`;
}

export function designSettings(config: DomainConfig, requestOrigin: string): string {
  // RenderingExtension.design_settings: font_url resolves against the asset host, else the request's own origin.
  const origin = assetHost(config) ?? requestOrigin;
  return JSON.stringify({ font: { name: "ABC Favorit", url: `${origin}/fonts/ABCFavorit-Regular.woff2` } });
}

// layouts/home.html.erb wrapped in layouts/application.html.erb. `view` is the page template's output.
export function renderHomeLayout(ctx: LayoutContext, view: string, requestOrigin: string): string {
  if (!ctx.hideLayouts) throw new NotPortedError("a home page that keeps the base entrypoint");
  const bodyClass = [
    "group/body",
    ...(ctx.userAgent?.includes("Macintosh") ? ["mac"] : []),
    ...(ctx.bodyClass ? [ctx.bodyClass] : []),
  ];
  const content = `  <div class="block bg-white text-black dark:bg-black dark:text-white font-['ABC_Favorit'] text-base font-normal leading-relaxed tracking-tight">
    ${nav(ctx)}
    <div class="overflow-hidden">
      ${view}
    </div>
  </div>
`;
  const script = `  ${scripts(ctx.nonce)}\n`;
  return `\n\n<!DOCTYPE html>
<html lang="en">
  ${head(ctx)}
  <body id="" class="${bodyClass.join(" ")}" style="${ctx.asEmbed ? "background: transparent" : ""}">
    <div id="design-settings" data-settings="${escapeHtml(designSettings(ctx.config, requestOrigin))}" style="display: none;"></div>
    ${flashPartial(ctx)}
    <div class="flex flex-col lg:flex-row h-screen">
      <main class="flex-1 flex flex-col lg:h-screen overflow-y-auto">
        <div class="flex-1 flex flex-col">
          ${content}
        </div>
      </main>
    </div>
    ${script}
  </body>
</html>

`;
}

// `<%= yield :script %>` with nothing to yield: its indentation and the newline.
const YIELD_SCRIPT_LINE = "    \n";

// layouts/application.html.erb around a page that keeps the base entrypoint (`@hide_layouts` unset). `view` is the template's output.
export function renderApplicationLayout(ctx: LayoutContext, view: string, requestOrigin: string): string {
  if (ctx.hideLayouts) throw new NotPortedError("a page that hides the base entrypoint");
  const bodyClass = [
    "group/body",
    ...(ctx.userAgent?.includes("Macintosh") ? ["mac"] : []),
    ...(ctx.bodyClass ? [ctx.bodyClass] : []),
  ];
  return `<!DOCTYPE html>
<html lang="en">
  ${head(ctx)}
  <body id="" class="${bodyClass.join(" ")}" style="${ctx.asEmbed ? "background: transparent" : ""}">
    <div id="design-settings" data-settings="${escapeHtml(designSettings(ctx.config, requestOrigin))}" style="display: none;"></div>
    ${flashPartial(ctx)}
    <div class="flex flex-col lg:flex-row h-screen">
      <main class="flex-1 flex flex-col lg:h-screen overflow-y-auto">
        <div class="flex-1 flex flex-col">
          ${view}
        </div>
      </main>
    </div>
      ${viteTypescriptTag("base").tags}
${YIELD_SCRIPT_LINE}  </body>
</html>
`;
}

export type { Html };
