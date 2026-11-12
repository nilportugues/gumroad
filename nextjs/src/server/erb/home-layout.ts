// Port of app/views/layouts/home.html.erb and layouts/application.html.erb with their head partial (the flash partial renders nothing: pages with a flash hand back), and of the
// home/shared partials the pages share (nav, header, button, how_we_build, scripts, footer). Whitespace is Erubi's: a `<% %>` line
// disappears with its newline, a `<%= %>` keeps the indentation in front of it and the newline after it.
//
// The nav, header, button and how_we_build partials hold Ruby (methods, hashes, string interpolation), so they are written out
// here; the footer and the scripts are plain markup and are read from the .erb files Rails renders.
import { storageConfig } from "../infra/storage.ts";
import { viteEntrypointStylesheet } from "../infra/vite.ts";
import { assetHost, type DomainConfig } from "../page-props/domain.ts";
import { type MetaTagBuilder } from "../page-props/meta-tags.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { buttonTag, contentTag, escapeHtml, html, type Html, imageTag, linkTo, SafeString } from "./html.ts";
import { type Helpers, readView, renderErb } from "./template.ts";

export type LayoutContext = {
  config: DomainConfig;
  // request.path and request.headers["User-Agent"].
  path: string;
  method: string;
  userAgent: string | null;
  asEmbed: boolean;
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

// The helpers the home views call with literal arguments. `render` knows the two partials those views render without a block.
export function homeHelpers(config: DomainConfig): Helpers {
  return {
    render: ({ positional, keywords }) => {
      const partial = positional[0];
      if (partial === "home/shared/footer") return new SafeString(footer(config));
      if (partial !== "home/shared/button") throw new NotPortedError(`the partial ${String(partial)}`);
      return new SafeString(
        button({
          text: String(keywords.text),
          url: String(keywords.url),
          ...(keywords.variant ? { variant: String(keywords.variant) } : {}),
          ...(keywords.type ? { type: String(keywords.type) } : {}),
          ...(keywords.size ? { size: String(keywords.size) } : {}),
        }),
      );
    },
    image_tag: ({ positional, keywords }) => imageTag(imagePath(config, String(positional[0])), keywords),
    link_to: ({ positional, keywords }) => linkTo(String(positional[0]), String(positional[1]), keywords),
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
  const classes = `flex w-full items-center justify-center h-full ${
    primary
      ? "lg:bg-black lg:text-white lg:hover:bg-pink"
      : "lg:border-l-black lg:bg-white lg:text-black lg:hover:bg-pink dark:lg:border-l-white/35 dark:lg:bg-black dark:lg:text-white"
  } border-black bg-black p-4 text-lg text-white no-underline transition-colors duration-200 hover:bg-pink hover:text-black lg:w-auto lg:border-l lg:py-2 lg:px-6 whitespace-nowrap ${
    primary
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
  if (ctx.signedIn) throw new NotPortedError("the nav of a signed-in visitor");
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
        authButton("Log in", PATHS.login_path!, false) + authButton("Start selling", PATHS.signup_path!, true),
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
  if (stars === null) throw new NotPortedError("the nav without a cached GitHub star count");
  const star = /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24" width="18"[\s\S]*?<\/svg>/u.exec(
    readView("home/shared/_nav.html.erb"),
  )![0];
  const classes =
    "flex gap-1.5 rounded-full p-1.5 border border-black no-underline dark:border-white/35 hover:bg-gray-100 dark:hover:bg-gray-700 text-black dark:text-white hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[2px_2px_0_0_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0_0_rgba(255,255,255,0.35)] transition-all duration-100";
  const content = `
      ${GITHUB_ICON_PATH}
        <div class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="text-base leading-none font-medium">${numberToSi(stars)}</span>
          ${star}
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

// layouts/shared/_flash.html.erb without a flash.
const NO_FLASH = "";

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
  if (ctx.asEmbed) throw new NotPortedError("as_embed");
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
  <body id="" class="${bodyClass.join(" ")}" style="">
    <div id="design-settings" data-settings="${escapeHtml(designSettings(ctx.config, requestOrigin))}" style="display: none;"></div>
    ${NO_FLASH}
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

export type { Html };
