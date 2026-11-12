// Devise's own views, which the app does not override: ConfirmationsController#new renders the gem's
// devise/confirmations/new.html.erb in layouts/application.html.erb. The pages the app does override (login, signup, forgot password)
// are Inertia pages and live in auth-pages.ts.
import { escapeHtml } from "../erb/html.ts";
import { perFormCsrfToken } from "../page-props/csrf.ts";

import { type ActionContext, HandBackToRails, type Rendered } from "./application-controller.ts";
import { renderApplicationPage } from "./erb-pages.ts";
import { requestFormat } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

// User.omniauth_providers, in the order `devise :omniauthable` lists them.
const OMNIAUTH_PROVIDERS = ["twitter", "stripe_connect", "google_oauth2", "youtube", "instagram", "tiktok", "apple"];

// OmniAuth::Utils.camelize: `google_oauth2` is "GoogleOauth2", `stripe_connect` is "StripeConnect".
const camelize = (name: string) => name.replace(/(?:^|_)([a-z\d])/gu, (_match, char: string) => char.toUpperCase());

const tokenField = (token: string) =>
  `<input type="hidden" name="authenticity_token" value="${escapeHtml(token)}" autocomplete="off" />`;

// The error_messages partial renders nothing for a resource without errors, leaving the two spaces of its line.
const ERROR_MESSAGES_LINE = "  \n";

// devise/confirmations/new.html.erb with devise/shared/_links.html.erb, for a `User.new` resource with no errors.
function confirmationNewView(csrfToken: string): string {
  const providers = OMNIAUTH_PROVIDERS.map((provider) => {
    const action = `/users/auth/${provider}`;
    return `    <form class="button_to" method="post" action="${action}"><button data-turbo="false" type="submit">Sign in with ${camelize(provider)}</button>${tokenField(perFormCsrfToken(csrfToken, action, "post"))}</form><br />\n`;
  }).join("");
  return `<h2>Resend confirmation instructions</h2>

<form class="new_user" id="new_user" action="/users/confirmation" accept-charset="UTF-8" method="post">${tokenField(perFormCsrfToken(csrfToken, "/users/confirmation", "post"))}
${ERROR_MESSAGES_LINE}
  <div class="field">
    <label for="user_email">Email</label><br />
    <input autofocus="autofocus" autocomplete="email" value="" type="email" name="user[email]" id="user_email" />
  </div>

  <div class="actions">
    <input type="submit" name="commit" value="Resend confirmation instructions" data-disable-with="Resend confirmation instructions" />
  </div>
</form>
  <a href="/users/sign_in">Log in</a><br />

  <a href="/users/sign_up">Sign up</a><br />

  <a href="/users/forgot_password/new">Forgot your password?</a><br />



${providers}
`;
}

// GET /users/confirmation/new
export function confirmationNewPage(request: RailsRequest, action: ActionContext): Promise<Rendered> {
  // Rails answers an Inertia visit or a non-HTML format (406) from the same action; neither is a page to serve here.
  if (request.headers.has("x-inertia")) throw new HandBackToRails("an Inertia visit of a Devise view");
  if (requestFormat(request) !== "html") throw new HandBackToRails("a Devise view in another format");
  return renderApplicationPage(request, action, null, (_ctx, csrfToken) => confirmationNewView(csrfToken));
}
