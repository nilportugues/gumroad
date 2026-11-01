# Converting an Inertia page to the App Router

The reference conversions are `help/category/[slug]/` (`HelpCenter::CategoriesController#show` →
`HelpCenter/Categories/Show`) and `help/article/[slug]/` (with redirects and a per-request template). Rails keeps serving the original until the route's flag is on, so the
Rails files stay untouched.

## 1. Find what Rails does for the route

- `bin/rails routes -g <path>` (or `config/routes.rb`): the URL pattern, its host constraint
  (`GumroadDomainConstraint`, seller subdomain, custom domain) and its route name.
- The controller action, its `before_action`s, every `inertia_share` on the controller and its
  ancestors, and the presenter that builds the props.
- The page component in `app/javascript/pages/<Component>.tsx`, and whether it sets
  `Page.publicLayout` / `Page.loggedInUserLayout` (that picks the shell layout).

## 2. Port the props (server)

- Put the presenter port in `src/server/page-props/<area>.ts`. Keep field names and order, URL
  helpers from `@/lib/navigation/routes`, and pure functions you can test against Rails' output.
- Register the page in `src/server/page-props/pages.ts`, keyed by its `routes.json` pattern:
  `component`, `props(params, action)` and, for what Rails does before it renders, `redirect(params)`
  (a `before_action` redirect or a `rescue_from`; set `rescued: true` so the after_actions are
  skipped, as in Rails). Two things render a registered page and must answer alike: the App Router
  page (HTML) and the X-Inertia route handler (JSON, `server/controllers/inertia-page.ts`).
- Inside `props`:
  - `meta.set({...})` for every `set_meta_tag` (controller `before_action`s first, in order).
  - `urlOptions` for `*_url` helpers, so hosts match `ApplicationController#default_url_options`.
  - Set `mobileAppWebView: true` on the spec if the controller calls `enable_mobile_app_web_view`, and
    merge controller-level `inertia_share` props yourself (e.g. `settings_pages` for Settings pages).
- `page.tsx` is then `const page = await renderPage("/your/pattern", params)` (`render-page.ts`
  runs `loadPage`: the ApplicationController meta tags, your props, `inertia_share`, and the
  `deep_merge_shared_data` merge).
- `InertiaRails.defer { ... }`: pass the prop as an unawaited promise; `<Deferred>` and `usePage()`
  treat it as undefined until it resolves. `optional`/`merge`/`scroll` props have no equivalent yet
  (see "Not covered").
- Redirects: do not call `redirect()` for a status Rails sends (it can only send 307/308); put it in
  the spec's `redirect`. The proxy hands those requests to the route handler, which answers through
  `processAction` with Rails' status, headers and cookies.

### The Rails envelope around a page

A Rails Inertia response carries more than props: `x-gr`/`x-revision`, the CSRF-masked `XSRF-TOKEN`,
`_gumroad_guid` and session cookies, SecureHeaders, `Vary`, and `data-page` in the HTML. Next
produces them like this, and `page.tsx` does nothing for it:

- **HTML.** An App Router page cannot set headers or cookies, so `src/proxy.ts` runs the same chain
  as `processAction` (`pageEnvelope` in `application-controller.ts`: redirect_to_custom_subdomain,
  signup referrer, guid, CSRF, session commit, flash and `inertia_errors` consumption, SecureHeaders,
  Rack::Cors) and attaches the result to the response the page renders. What the render needs from
  the session travels in the `x-gr-render-state` request header, which only the proxy sets.
  `InertiaShell` writes `<script type="application/json" data-page="app">` with component, props,
  url, version, `encryptHistory` and `clearHistory`, in inertia_rails' key order.
- **X-Inertia.** For routes marked `"inertia": true`, the proxy rewrites X-Inertia requests to the
  internal `/gr-inertia` route handler, which runs `processAction` and answers with the page JSON
  (`x-inertia: true`, partial reloads via `X-Inertia-Partial-*`) or the 409 + `X-Inertia-Location`
  inertia_rails sends for a stale `X-Inertia-Version`. No asset version is configured in Rails, so
  any version header is stale. Routes without the marker keep going to Rails.
- **Known differences.** Next.js owns `Vary` and `Cache-Control` on rendered HTML (its RSC cache
  keys replace Rails' `X-Inertia`/`Origin`; `no-store` instead of `max-age=0, private,
  must-revalidate`), and there is no ETag/conditional GET on HTML (Rails' ETag digests a body that
  embeds a fresh CSRF token and nonce, so it never matched). `Link` preload headers name Vite
  assets. The JSON response is exact.

## 3. Copy the page component (client)

1. Copy the file next to `page.tsx` (e.g. `HelpCenterCategory.tsx`) and add `"use client";`.
2. Replace `from "@inertiajs/react"` (and `@inertiajs/core`) with `from "@/lib/navigation"`.
3. Rewrite relative imports to `$app/pages/...` (page-local helpers stay where they are), or
   copy them too if they are only used by this page.
4. Render it inside `<InertiaShell page={page} layout="...">` from `page.tsx` (a server component that
   also emits `data-page`; the client half is `InertiaShellClient`).

Shared components need no change: next.config.ts aliases `@inertiajs/*` to the compat module,
injects the `Routes` global, turns `$assets/...` imports into URL strings and defines `SSR`.

## 4. Route it

1. Add the path to `nextjs/routes.json` with a new Flipper flag, e.g.
   `"/help/category/:slug": { "flag": "nextjs_help_center_category" }`. `:param` excludes `.`
   like Rails, so `.html`/`.json` variants stay with Rails. Set `"hosts"` if the route is not on
   the app domain, and `"inertia": true` for every page registered in `pages.ts` (it turns on the
   envelope and the X-Inertia handling above). A page no longer needs `"signedOutOnly": true`: see
   "Signed-in requests". Keep it only for a route that still needs something from that list that is
   unported.
2. Add any helper the page graph needs to `src/lib/navigation/routes.ts`; `npx tsc --noEmit`
   lists the missing ones.

`GET /healthcheck` is deliberately not in the table even though `src/app/healthcheck/route.ts`
ports it: it is the blue/green readiness probe, so it must exercise Rails, and Rails answers it
without touching Redis, which a flagged route would (the proxy reads Flipper on every request).

### Signed-in requests

A signed-in visitor goes through the same chain, with the filters and shared props Rails adds for a
user. Nothing per page: `pageEnvelope`/`processAction` and `loadPage` do it all.

- **Who is acting.** `resolveAuth` (`server/auth/resolve.ts`) reads the Rails session and remember
  cookies and answers `current_user`, `current_seller` (the `current_seller_id` cookie, validated
  against the user's switchable team memberships) and the impersonated user (Redis key, team members
  only). `getRequestContext()` is that, per request, for a server component or a presenter.
- **Filters** (`beforeActions`, in Rails' order): `verify_current_seller` (a stale
  `current_seller_id` is deleted with a Set-Cookie), `seed_dashboard_nav_items` (a first visit to any
  dashboard path, `/help` included, inserts the user's earned nav rows and the `seeded` marker),
  `invalidate_session_if_necessary` (sign_out: the remember token is forgotten, the remember cookie
  deleted, the session cleared, a flash set and a 302 to `/login`), `set_signup_referrer` only for
  signed-out visitors, and `promote_visited_nav_item` after a successful render. `signed-in-filters.ts`
  holds the pieces.
- **Shared props** (`server/page-props/signed-in/`): `logged_in_user` (team memberships, brand account
  flags, the 20 policy verdicts, promoted nav items), `current_seller`, `current_user` and
  `prompt_passkey_setup`, registered as the default `SignedInPresentersPort`. The reads are plain SQL in
  `reads.ts`; compliance and time zone rules are over data dumped from Ruby
  (`scripts/dump-signed-in-data.rb`, re-run it when `Compliance::Countries` or the supported-country
  lists change).
- **Rendering.** A signed-in page is not rendered on the server: the dashboard Nav reads `window`
  while rendering, and Rails never server-renders Inertia pages either. `InertiaShellClient` renders
  nothing until the client hydrates; `data-page` and the headers are unaffected.
- **What goes to Rails.** A request that only a remember cookie signs in (no usable session) is sent
  to Rails by the route gate: Devise writes the session and the tracked sign-in fields there. Once the
  browser holds the session cookie, Next serves it.
- **Ported in WS-53.** `User#avatar_url` and `OauthApplication#icon_url` for uploaded files
  (`page-props/signed-in/avatar.ts`, `infra/active-storage.ts`, `infra/cdn-url.ts`: the variant record
  keyed by the Variation's Marshal digest, the public bucket, the same `Rails.cache` entries, the CDN
  rewrite); `use_store_agent` (`search/purchase-sales.ts`, the `sales_cents_total` aggregations, golden
  from the real Elasticsearch); a US minor's guardian (`Guardian#has_completed_info?`) and the payout
  setup rejection note; `check_suspended` on a non-GET request; `invalidate_session_if_necessary` on a
  host that is not the app's (signs out and carries on); API token authentication as a reusable module
  (`auth/api-token.ts`: Doorkeeper lookup, MCP binding, brand-token validity, `current_api_user`,
  `doorkeeper_authorize!` with the v2 overrides, `require_oauth_scope!`).
- **What is not ported (it throws `NotPortedError`, a 500, instead of guessing).** An avatar variant
  Rails has not processed yet, or whose file vanished from the bucket (ImageMagick makes it); an
  attachment on a service other than the environment's; Devise's remember-cookie sign-in. Port the
  missing piece before flagging a route whose users hit it.
- **Known differences.** Team members' responses lack Rack::MiniProfiler's `__profilin` cookie, and
  sign-out writes its `versions` row without the request's IP, path and UUID. `check_suspended` reads a
  `format` param from the query only, not a form body; the production public URL assumes the legacy global
  S3 endpoint (`<bucket>.s3.amazonaws.com`), as the CDN map's keys do.

## 5. Verify

- `npx tsc --noEmit`, `npx vitest run`, `npx next build`.
- Locally: `NEXTJS_ROUTE_FLAGS=<flag> NEXTJS_ASSUME_SIGNED_OUT=1
  RAILS_ORIGIN=http://localhost:3000 npm run dev` and open the page on port 3100.
- Parity for a signed-in page: add a request spec under `spec/requests/` that logs in through
  `POST /login` (forgery protection is on in the test environment, so fetch a page's
  `authenticity_token` first), tag the examples `parity: true`, record with `PARITY_RECORD=1`, and
  replay the request under test with `replayFixtureExchange` (see
  `parity/__tests__/help-center-signed-in.replay.test.ts` and the parity README).
- Parity: replay the controller-spec fixtures against a running Next
  (`parity/__tests__/help-center.replay.test.ts` boots `next dev` and compares status, headers,
  cookies and the `data-page` props). Ignore `authenticity_token`/`csrf-token` (masked per call) and
  `csp_nonce`.

## Not covered yet (convert by hand)

- `InertiaRails.merge`/`scroll` (append-on-paginate) and `optional` props: `router.reload({ only })`
  re-renders every prop, so pages that page through lists by merging need a client fetch or a
  server action instead.
- `<InfiniteScroll>` and `<Form>` throw; `useRemember` uses sessionStorage instead of history state.
- `import.meta.glob` (Vite-only) in a page's import graph fails to build.
- Mutations still go to Rails over the Inertia protocol (`useForm.post` etc.); once an endpoint is
  ported, return a redirect from a route handler or use a server action.

## Pages behind authentication and authorization

A page that needs a signed-in visitor (`authenticate_user!`) and a Pundit verdict registers a `guard`
next to its `props` in `pages.ts` (see `server/page-props/settings/pages.ts`):

- `guard({ context, config, url, urlOptions })` returns a `Redirected` or null. It runs after `redirect`
  and before the render, in the proxy (`proxy-preflight.ts`, to decide whether the route handler must
  answer) and in the X-Inertia handler. `Redirected.flash` is what the action put in `flash[:alert]`;
  the Rails chain writes it into the session cookie. Use `rescued: true`, as for any `rescue_from`.
- `settingsGuard` ports `Sellers::BaseController` (`require_account_email`, `authenticate_user!`), the
  controller's `authorize` and `PunditAuthorization#user_not_authorized` (the flash naming the role,
  or the profile redirect for `Settings::Main::UserPolicy#show?`).
- routes.json: `"signedInOnly": true` sends a signed-out request to Rails (Devise's failure app,
  `?next=` and its flash are Rails'). A signed-out request that reaches the guard anyway throws.
- The policies are plain functions in `server/policies/settings/`; `settingsPages` (the `settings_pages`
  inertia_share) is evaluated for every Settings page.
- Type checking: `src/types/rails-app-types.d.ts` pulls in the ambient declarations the Rails app's
  tsconfig gives `app/javascript`. A page whose component graph is large still shows errors that come
  from the shared components themselves (React types resolved from the Rails app's `node_modules`).

## A controller with its own filters (the authentication pages)

`/login`, `/oauth/login`, `/signup`, `/two-factor` and `/secure_url_redirect` are Inertia pages whose
controllers run filters of their own, so their `PageSpec` carries `options` (`controllers/auth-pages.ts`):

- `prepended`: Devise's `prepend_before_action`s (`require_no_authentication`). They run before every
  ApplicationController filter, so a redirect answers with the session cookie only (no `x-gr`, no guid, no
  XSRF-TOKEN), as Rails does.
- `filters`: the controller's own `before_action`s and the start of its action, after ApplicationController's.
  Return `{ halt }` for a redirect or `head` (a `rescued` halt skips the after_actions; an action-level
  redirect does not), or `{ state }` for what the props need (`action.state`). A filter may write the
  session (the WebAuthn challenge, the flash): the session cookie is committed after it runs.
- Both the proxy's envelope and the X-Inertia handler run the chain with these options; for a stale
  `X-Inertia-Version` a halt becomes the 409, as inertia_rails replaces the controller's response.
- A callback re-declared in a subclass moves to the end of Rails' chain, which reorders the meta tags it
  sets: use `meta.moveToEnd(...)` (see `loginPageProps`).
- Anything the port cannot prove throws `HandBackToRails`: the request goes to Rails whole (the envelope
  returns Rails' response; the handler forwards it). `rails-params.ts` uses it for `params` that are
  arrays or hashes, `Accept` lists whose format Rails would rank differently, and `next` values whose
  Addressable/URI handling raises in Ruby (`SafeRedirectPathService` is checked against Ruby output in
  `__fixtures__/safe-redirect-path.golden.json`).
- `clientOnly` on `InertiaShell` renders the page in the browser only: login and signup mount a portal
  into `document.body` while rendering, which Rails never did on the server either.
