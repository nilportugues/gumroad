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
  renderApplicationLayout,
  renderHomeLayout,
} from "../erb/home-layout.ts";
import { imageTag } from "../erb/html.ts";
import { generateCspNonce } from "../infra/secure-headers.ts";
import { viteEntrypointStylesheet, viteTypescriptTag } from "../infra/vite.ts";
import { formAuthenticityToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { MetaTagBuilder } from "../page-props/meta-tags.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import type { SharedPropsPorts } from "../page-props/ports.ts";
import { applicationMetaTags } from "../page-props/shared.ts";
import { signedInPresenters } from "../page-props/signed-in/presenters.ts";

import { type ActionContext, HandBackToRails, type Rendered } from "./application-controller.ts";
import { rackTopLevelParams } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

const GITHUB_STARS_CACHE_KEY = "github_stars_antiwork/gumroad";
const HTML = "text/html; charset=utf-8";

const GITHUB_STARS_TTL_SECONDS = 60 * 60;
const GITHUB_STARS_RACE_CONDITION_TTL_SECONDS = 10;
const GITHUB_REQUEST_TIMEOUT_MS = 5000;
// The origin is a variable only so a replay can stand in for GitHub (as TAXJAR_ENDPOINT does for TaxJar).
const githubApiOrigin = () => process.env.GITHUB_API_ORIGIN?.trim() || "https://api.github.com";

// GithubStarsController.fetch_stars. Any failure answers nil, which the cache stores and the nav renders without a count.
async function fetchGithubStars(): Promise<number | null> {
  try {
    const response = await fetch(`${githubApiOrigin()}/repos/antiwork/gumroad`, {
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const json = response.ok && /json/iu.test(response.headers.get("content-type") ?? "");
    const parsed: unknown = json ? await response.json() : null;
    const stars =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { stargazers_count?: unknown }).stargazers_count
        : null;
    // A count that is not an Integer would print differently from `number_to_si`'s Integer path.
    if (stars != null && (typeof stars !== "number" || !Number.isSafeInteger(stars)))
      throw new HandBackToRails("a GitHub star count that is not an integer");
    return stars ?? null;
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    return null;
  }
}

// GithubStarsController.cached_count
async function cachedGithubStars(): Promise<number | null> {
  const stars = await railsCache().fetch(
    GITHUB_STARS_CACHE_KEY,
    { expiresIn: GITHUB_STARS_TTL_SECONDS, raceConditionTtl: GITHUB_STARS_RACE_CONDITION_TTL_SECONDS },
    () => fetchGithubStars(),
  );
  // Rails.cache.fetch answers whatever a Ruby writer stored; only an Integer prints.
  if (stars !== null && typeof stars !== "number")
    throw new HandBackToRails("a GitHub star count that is not an integer");
  return stars;
}

// `params[:as_embed]` is truthy: a flat `as_embed=` is an empty string (truthy in Ruby), a bare `as_embed` is nil, and a list or hash is truthy.
function asEmbedParam(queryString: string): boolean {
  const param = rackTopLevelParams(queryString).get("as_embed");
  return param !== undefined && (param.nested || param.value !== null);
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

// The layout reads the signed-in seller only for the third-party analytics flag.
const PORTS = { presenters: signedInPresenters } as SharedPropsPorts;

type ErbLayout = "home" | "application";

// `csrfToken` is the session's real token, for the forms a view signs itself.
export type ErbView = (ctx: LayoutContext, csrfToken: string) => string;

export async function renderHomePage(
  request: RailsRequest,
  action: ActionContext,
  page: PageMeta | ((origin: string) => PageMeta),
  view: (ctx: LayoutContext) => string,
  response: { paramsRead?: boolean; headers?: Record<string, string> } = {},
): Promise<Rendered> {
  return renderErbPage(request, action, "home", page, view, response);
}

// A page in layouts/application.html.erb that keeps the base entrypoint, as Devise's views do.
export function renderApplicationPage(
  request: RailsRequest,
  action: ActionContext,
  page: PageMeta | null,
  view: ErbView,
  { footer, analyticsFirst = true }: { footer?: string; analyticsFirst?: boolean } = {},
): Promise<Rendered> {
  return renderErbPage(request, action, "application", page, view, {}, footer, analyticsFirst);
}

async function renderErbPage(
  request: RailsRequest,
  action: ActionContext,
  layout: ErbLayout,
  page: PageMeta | ((origin: string) => PageMeta) | null,
  view: ErbView,
  response: { paramsRead?: boolean; headers?: Record<string, string> },
  footer?: string,
  analyticsFirst = layout === "application",
): Promise<Rendered> {
  const config = domainConfig(process.env);
  // `signed_in?` is the Warden session, which an impersonating admin has as themselves.
  const signedIn = railsLoggedInUser(action.context) !== null;
  const origin = `${config.protocol}://${request.hostWithPort}`;
  const githubStars = layout === "home" ? await cachedGithubStars() : null;
  const state = action.takeRenderState();
  const meta = new MetaTagBuilder();
  await applicationMetaTags(meta, {
    context: action.context,
    config,
    csrfToken: formAuthenticityToken(state.csrfToken),
    ports: PORTS,
    analyticsFirst,
  });
  if (page !== null) pageMetaTags(meta, typeof page === "function" ? page(origin) : page);
  const nonce = generateCspNonce();
  const ctx: LayoutContext = {
    config,
    path: request.path,
    method: request.method,
    userAgent: request.headers.get("user-agent"),
    asEmbed: asEmbedParam(request.queryString),
    flash: state.flash,
    nonce,
    meta,
    githubStars,
    signedIn,
    hideLayouts: layout === "home",
  };
  // A tag the ERB table does not list is a page Rails renders, not one to guess.
  let renderedBody: string;
  let link = viteEntrypointStylesheet("entrypoints/design.scss").linkHeader;
  try {
    const content = view(ctx, state.csrfToken);
    if (layout === "home") renderedBody = renderHomeLayout(ctx, content, origin);
    else {
      renderedBody = renderApplicationLayout(ctx, content, origin, footer);
      link = `${link},${viteTypescriptTag("base").linkHeader}`;
    }
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  return {
    status: 200,
    body: renderedBody,
    contentType: HTML,
    headers: { ...response.headers, link },
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
