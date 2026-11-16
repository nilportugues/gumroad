// #oauth_redirect of Integrations::ZoomController and Integrations::GoogleCalendarController (GET /integrations/{zoom,google_calendar}/oauth_redirect):
// `render inline: "", layout: "application"`, answering 400 when the request carries no `code` key. The page is the bare layout, which
// the frontend reads the code from.
import { HandBackToRails, type ActionContext, type Rendered } from "./application-controller.ts";
import { renderApplicationPage } from "./erb-pages.ts";
import { rackTopLevelParams, requestFormat } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

export function integrationsOauthRedirectPage(request: RailsRequest, action: ActionContext): Promise<Rendered> {
  // Rails answers an Inertia visit or a non-HTML format from the same action; neither is a page to serve here.
  if (request.headers.has("x-inertia")) throw new HandBackToRails("an Inertia visit of an empty layout page");
  if (requestFormat(request) !== "html") throw new HandBackToRails("an empty layout page in another format");
  const status = rackTopLevelParams(request.queryString).has("code") ? HTTP_OK : HTTP_BAD_REQUEST;
  return renderApplicationPage(request, action, null, () => "", { status, analyticsFirst: false });
}
