// The controllers that render ERB in the `home` layout: GumclawController#index. Each page is the layout (erb/home-layout.ts) around
// the markup of its own view.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { railsCache } from "../cache/rails-cache.ts";
import {
  button,
  footer,
  header,
  howWeBuild,
  imagePath,
  type LayoutContext,
  renderHomeLayout,
} from "../erb/home-layout.ts";
import { imageTag } from "../erb/html.ts";
import { generateCspNonce } from "../infra/secure-headers.ts";
import { viteEntrypointStylesheet } from "../infra/vite.ts";
import { formAuthenticityToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { MetaTagBuilder } from "../page-props/meta-tags.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import type { SharedPropsPorts } from "../page-props/ports.ts";
import { applicationMetaTags } from "../page-props/shared.ts";

import { type ActionContext, HandBackToRails, type Rendered } from "./application-controller.ts";
import type { RailsRequest } from "./rails-request.ts";

const GITHUB_STARS_CACHE_KEY = "github_stars_antiwork/gumroad";
const HTML = "text/html; charset=utf-8";

// GithubStarsController.cached_count: a miss makes Rails call the GitHub API, and a cached nil renders another nav, so both stay
// Rails'.
async function cachedGithubStars(): Promise<number> {
  const stars = await railsCache().read(GITHUB_STARS_CACHE_KEY);
  if (typeof stars !== "number") throw new HandBackToRails("the nav without a cached GitHub star count");
  return stars;
}

export type PageMeta = { title: string; description: string; url: string };

// The controller's `set_meta_data`, which runs after ApplicationController's before_actions have set the defaults.
function pageMetaTags(meta: MetaTagBuilder, { title, description, url }: PageMeta) {
  meta.set({ title });
  meta.set({ name: "description", content: description });
  meta.set({ tag_name: "link", rel: "canonical", href: url, head_key: "canonical" });
  meta.set({ property: "og:title", content: title });
  meta.set({ property: "og:description", content: description });
  meta.set({ property: "og:type", content: "website" });
  meta.set({ property: "og:url", content: url });
}

// No port exists for the signed-in half of the shared props; the layout only reads the seller for the analytics flags.
const NO_PORTS = {} as SharedPropsPorts;

export async function renderHomePage(
  request: RailsRequest,
  action: ActionContext,
  page: PageMeta | ((origin: string) => PageMeta),
  view: (ctx: LayoutContext) => string,
  response: { paramsRead?: boolean; headers?: Record<string, string> } = {},
): Promise<Rendered> {
  const config = domainConfig(process.env);
  // A signed-in visitor sees the Dashboard nav and the seller-aware analytics flags, none of it recorded.
  if (railsLoggedInUser(action.context) !== null) throw new HandBackToRails("a home page for a signed-in visitor");
  const origin = `${config.protocol}://${request.hostWithPort}`;
  const githubStars = await cachedGithubStars();
  const state = action.takeRenderState();
  // layouts/shared/_flash.html.erb renders a toast for it, which no example records.
  if (Object.keys(state.flash).length > 0) throw new HandBackToRails("a home page with a flash message");
  const meta = new MetaTagBuilder();
  await applicationMetaTags(meta, {
    context: action.context,
    config,
    csrfToken: formAuthenticityToken(state.csrfToken),
    ports: NO_PORTS,
  });
  pageMetaTags(meta, typeof page === "function" ? page(origin) : page);
  const nonce = generateCspNonce();
  const ctx: LayoutContext = {
    config,
    path: request.path,
    method: request.method,
    userAgent: request.headers.get("user-agent"),
    asEmbed: new URLSearchParams(request.queryString).has("as_embed"),
    nonce,
    meta,
    githubStars,
    signedIn: false,
    hideLayouts: true,
  };
  // A tag the ERB table does not list is a page Rails renders, not one to guess.
  let renderedBody: string;
  try {
    renderedBody = renderHomeLayout(ctx, view(ctx), origin);
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  return {
    status: 200,
    body: renderedBody,
    contentType: HTML,
    headers: { ...response.headers, link: viteEntrypointStylesheet("entrypoints/design.scss").linkHeader },
    cspNonce: nonce,
    paramsRead: response.paramsRead ?? true,
  };
}

// app/views/gumclaw/index.html.erb
function gumclawView({ config }: LayoutContext): string {
  const learnMore = (variant?: string) =>
    button({ text: "Learn more at Antiwork", url: "https://antiwork.com", ...(variant ? { variant } : {}) });
  const cards = [
    {
      icon: "careers/audience.svg",
      iconBg: "pink",
      title: "Runs support",
      description:
        "Gumclaw answers creator tickets, issues refunds, reviews risk, and resolves payout questions autonomously, around the clock.",
    },
    {
      icon: "careers/launch.svg",
      iconBg: "yellow",
      title: "Ships code",
      description:
        "It writes production code, opens pull requests, and fixes bugs directly in our open-source repository.",
    },
    {
      icon: "careers/flag.svg",
      iconBg: "purple",
      title: "Handles operations",
      description:
        "From reconciliation to compliance to monitoring, Gumclaw runs the day-to-day so the team can focus on building.",
    },
  ];
  const heroHeader = header({
    bgColor: "dark-gray",
    textColor: "white",
    subtitle: "Meet Gumclaw",
    title: 'Gumroad is run<br class="sm:hidden"> <span class="whitespace-nowrap">by an agent.</span>',
    description:
      "Gumclaw is the autonomous AI agent that runs Gumroad, handling support, operations, and engineering end-to-end.",
    noBorder: true,
    gap: "gap-8 md:gap-12",
    content: `\n      ${learnMore("dark")}\n`,
  });
  return `<div class="min-h-screen">
  <div class="-mb-8 lg:-mb-20">
    ${heroHeader}  </div>

  <div class="relative bg-dark-gray">
    <div class="text-white pt-16 sm:pt-24 pb-32">
      <div class="flex flex-col justify-center gap-4 sm:gap-6 mx-auto text-center max-w-5xl mb-12 sm:mb-16 px-8 md:mb-28">
        <h2 class="text-4xl md:text-6xl lg:text-7xl">How it works</h2>
        <p class="text-lg md:text-2xl">We replaced the org chart with an agent that ships.</p>
      </div>
      ${howWeBuild(config, cards)}
    </div>
  </div>

  <div class="px-8 py-16 lg:px-[4vw] lg:py-24">
    <div class="flex flex-col gap-8 lg:gap-16 max-w-5xl mx-auto items-center text-center">
      <h1 class="font-medium text-4xl sm:text-5xl lg:text-7xl">Curious how a company runs on an agent?</h1>
      <p class="text-lg md:text-2xl max-w-3xl">Antiwork builds the tools and the agents behind Gumroad. See how we work.</p>
      ${learnMore()}
    </div>
  </div>

  ${imageTag(imagePath(config, "about/new-sale.svg"), { alt: "Gumroad illustration", class: "w-full min-h-[300px] object-cover" }).value}

  ${footer(config)}
</div>
`;
}

export function gumclawPage(request: RailsRequest, action: ActionContext): Promise<Rendered> {
  const url = (origin: string) => `${origin}/gumclaw`;
  return renderHomePage(
    request,
    action,
    (origin) => ({
      title: "Gumclaw - The agent that runs Gumroad",
      description:
        "Gumroad is run by Gumclaw, an autonomous AI agent that handles support, operations, and engineering. Learn how we build at Antiwork.",
      url: url(origin),
    }),
    gumclawView,
  );
}
