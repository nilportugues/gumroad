// Devise's own views, which the app does not override: ConfirmationsController#new renders the gem's
// devise/confirmations/new.html.erb in layouts/application.html.erb. The pages the app does override (login, signup, forgot password)
// are Inertia pages and live in auth-pages.ts.
import { escapeHtml } from "../erb/html.ts";
import { perFormCsrfToken } from "../page-props/csrf.ts";

import { type ActionContext, HandBackToRails, NotAcceptable, type Rendered } from "./application-controller.ts";
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

export type ConfirmationForm = {
  // The one error on :email, from Devise's `find_or_initialize_with_error_by` or `add_error_on` ("Email not found").
  error?: string;
  // The resource's email: what the visitor typed for a new record, the stored one for a found account.
  email?: string;
  // form_for names a persisted resource's form `edit_user`.
  persisted?: boolean;
};

// devise/shared/_error_messages.html.erb for a resource with one error, after the two spaces its template line starts with.
const errorMessages = (error: string) =>
  `  <div id="error_explanation" data-turbo-cache="false">
    <h2>
      1 error prohibited this user from being saved:
    </h2>
    <ul>
        <li>${escapeHtml(error)}</li>
    </ul>
  </div>
`;

// devise/confirmations/new.html.erb with devise/shared/_links.html.erb.
export function confirmationNewView(csrfToken: string, form: ConfirmationForm = {}): string {
  const formName = form.persisted === true ? "edit_user" : "new_user";
  const failed = form.error !== undefined;
  const fieldWithErrors = (markup: string) => (failed ? `<div class="field_with_errors">${markup}</div>` : markup);
  const providers = OMNIAUTH_PROVIDERS.map((provider) => {
    const action = `/users/auth/${provider}`;
    return `    <form class="button_to" method="post" action="${action}"><button data-turbo="false" type="submit">Sign in with ${camelize(provider)}</button>${tokenField(perFormCsrfToken(csrfToken, action, "post"))}</form><br />\n`;
  }).join("");
  return `<h2>Resend confirmation instructions</h2>

<form class="${formName}" id="${formName}" action="/users/confirmation" accept-charset="UTF-8" method="post">${tokenField(perFormCsrfToken(csrfToken, "/users/confirmation", "post"))}
${failed ? `  ${errorMessages(form.error!)}\n` : ERROR_MESSAGES_LINE}
  <div class="field">
    ${fieldWithErrors('<label for="user_email">Email</label>')}<br />
    ${fieldWithErrors(`<input autofocus="autofocus" autocomplete="email" value="${escapeHtml(form.email ?? "")}" type="email" name="user[email]" id="user_email" />`)}
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
  // An Inertia visit gets the same page; a lone `Accept: application/json` is a 406. Other formats are not recorded.
  const inertia = request.headers.has("x-inertia");
  if (!inertia && request.headers.get("accept") === "application/json" && !request.headers.has("x-requested-with"))
    throw new NotAcceptable();
  if (requestFormat(request) !== "html") throw new HandBackToRails("a Devise view in another format");
  return renderApplicationPage(request, action, null, (_ctx, csrfToken) => confirmationNewView(csrfToken));
}

// ConfirmationsController#create ending in `respond_with resource`: the same view with the resource's error, a 200.
export function confirmationFormPage(
  request: RailsRequest,
  action: ActionContext,
  form: ConfirmationForm,
): Promise<Rendered> {
  return renderApplicationPage(request, action, null, (_ctx, csrfToken) => confirmationNewView(csrfToken, form));
}
