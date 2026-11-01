// The before_actions of a signed-in page that can end the request with a redirect: authorization
// (Pundit's rescue_from handler) and the controller's own checks. They need who is acting, which
// `PageSpec.redirect` (params only) does not have; both renderers of a page run them.
import type { RequestContext } from "../auth/context.ts";
import type { Redirected } from "../controllers/application-controller.ts";
import type { DomainConfig } from "./domain.ts";

export type GuardInput = {
  context: RequestContext;
  config: DomainConfig;
  url: URL;
  // ApplicationController#default_url_options, for `*_url` helpers.
  urlOptions: { protocol: string; host: string };
};

export type PageGuard = (input: GuardInput) => Promise<Redirected | null>;
