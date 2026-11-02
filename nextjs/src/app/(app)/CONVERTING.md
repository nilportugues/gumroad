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

- `<Form>` throws; `useRemember` (and `router.remember`/`restore`) use sessionStorage instead of history state.
  `InertiaRails.scroll` and `<InfiniteScroll>` are covered: see the WS-81 section.
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

## Page spec options (WS-55)

- `options.optOutOfCsp`: the controller's `opt_out_of_header(:csp)` (PublicController).
- `redirect(params, { url, headers })` may be async and answer `NOT_FOUND` (`preflight.ts`) for `e404`;
  the `/gr-inertia` handler turns it into Rails' 404 page. The seller pages (`seller-pages.ts`) use a
  `guard` for the filters between `authenticate_user!` and the render (`set_page`, `authorize`) and are
  `signedInOnly` in routes.json.
  The test environment renders a 404 as Rails' exception debug page, so replays of 404s ignore the body.
- `"inertia": "only"` in routes.json: Next.js answers the X-Inertia visits (props proven by replay) and
  Rails keeps serving the HTML, for pages whose component Next.js cannot render yet (the page editor).
- Promotable dashboard pages: the nav props are built before the visit is promoted, as in Rails; the
  render promotes it after building them (`RenderState.promoteNavItemPath`).

## Seller pages: guards with params, lazy and merge props (WS-57)

- `PageSpec.guard` receives the route `params` and may throw `RoutingError` for `e404` (the preflight and the
  X-Inertia handler both answer it as a 404). `page-props/audience/seller-guard.ts` is `Sellers::BaseController`
  + `RequireAccountEmail` + the action's `authorize`, with Pundit's flash redirect.
- `lazy`, `optional` and `merge` (`page-props/lazy-props.ts`) are `-> {}`, `InertiaRails.optional` and
  `InertiaRails.merge`: resolved after the partial-reload filter, so a prop a response leaves out is never
  computed; `mergeProps` is written into the page object. The client side is in `lib/navigation/partial-reload.ts` (see "Partial reloads and merge props" below).
- The visited dashboard nav item is promoted by the render after it built the props
  (`RenderState.promoteNavItemPath`), as Rails promotes in an after_action.

## Buyer pages (WS-61)

GET renders only; every POST/PATCH/PUT/DELETE stays in Rails. Props live in `server/page-props/buyer/`, the controllers' filters in `server/controllers/buyer-pages.ts`, the policies in `server/policies/buyer.ts`. Parity: `spec/requests/buyer_pages_parity_spec.rb`, replayed by `parity/__tests__/buyer-pages.replay.test.ts`.

| Route (flag) | Rails | Notes |
| --- | --- | --- |
| `/users/forgot_password/new` (`nextjs_buyer_password_new`) | `User::PasswordsController#new` | Devise `require_no_authentication` reused from the auth pages. |
| `/users/forgot_password/edit` (`nextjs_buyer_password_edit`) | `User::PasswordsController#edit` | The reset token is digested with `server/auth/devise-token.ts` (needs `DEVISE_SECRET_KEY`). A request without a token goes to Rails (Devise sets a flash). |
| `/subscriptions/:subscription_id/magic_link/new` (`nextjs_buyer_subscription_magic_link`) | `Subscriptions::MagicLinksController#new` | Signed out or in. An unknown subscription is the 404. |
| `/purchases/:purchase_id/invoice/confirm` (`nextjs_buyer_invoice_confirm`) | `Purchases::InvoicesController#confirm` | `<Form>` is not in the compat module, so the copy posts through `useForm`. |
| `/wishlists`, `/wishlists/following` (`nextjs_buyer_wishlists`, `nextjs_buyer_wishlists_following`) | `WishlistsController#index`, `Wishlists::FollowingController#index` | `signedInOnly`. A JSON request goes to Rails. |
| `/reviews` (`nextjs_buyer_reviews`) | `ReviewsController#index` | `signedInOnly`. |
| `/library`, `/library/purchase/:id` (`nextjs_buyer_library`) | `LibraryController#index` | `signedInOnly`; see below. |

Signed-in buyer pages share `signedInFilters` (`authenticate_user!`, `RequireAccountEmail`, the Pundit refusal with its role message) instead of `PageSpec.guard`, because a filter can also hand the request back to Rails.

Handed back to Rails (`HandBackToRails`, decided in the filter before the page renders): a library request with `purchase_id` (post-checkout analytics), `bundles` or `subscriptions_only`; a library holding a membership, installment plan or bundle (subscription labels, no-access filtering, replaced bundle rows, ZIP downloads); an unconfirmed account (the page re-sends the confirmation email); non-HTML formats.

Throw `NotPortedError` (500): an uploaded thumbnail, cover preview or avatar (Active Storage variants and the CDN rewrite) and a review with a video (`ProductReviewVideo#video_file.thumbnail_url`).

Not ported, not in `routes.json`:

- `Wishlists/Show` (public, seller subdomains and custom domains): `WishlistPresenter#public_props` needs `ProductPresenter.card_for_web`, `ProfilePresenter#creator_profile` and the discover nav, none of which exist in TypeScript yet.
- `Subscriptions/Manage`: `CheckoutPresenter#subscription_manager_props` (565 lines: tier and recurrence pricing, offer codes, Stripe/PayPal payment method state and SCA). The token and cookie rules of `SubscriptionsController#check_can_manage` are not ported either.
- `Purchases/Product/Show`: `ProductPresenter#product_props` deep-merged with `PurchaseProductPresenter`.
- `Purchases/Invoices/New`: `InvoicePresenter` (form, supplier, seller and order info, tax and currency formatting) and `Charge::Chargeable`.
- `Purchases/DisputeEvidence/Show` and `Success`: the `SecureExternalId` token (an `ActiveSupport::MessageEncryptor` payload), `DisputeEvidencePagePresenter` and the evidence blobs (Active Storage).

## Payments, profile and application editor (Settings)

`/settings/payments` (`server/page-props/settings/payments.ts`), `/profile` (`profile.ts`) and
`/oauth/applications/:id/edit` are served behind `nextjs_settings_payments`, `nextjs_settings_profile` and
`nextjs_oauth_application_edit`; their recorded renders are replayed by
`parity/__tests__/settings-payments-profile.replay.test.ts`. Form submissions stay in Rails.

- **Strongbox.** `models/strongbox.ts` reads the RSA-encrypted tax-id columns with `STRONGBOX_GENERAL` and
  `STRONGBOX_GENERAL_PASSWORD` from the environment or credentials (Node refuses PKCS#1 v1.5 private
  decryption, so the block is decrypted raw and unpadded). `models/strongbox.test.ts` replays ciphertexts Ruby wrote.
- **Constant data.** Country lists, subdivisions, business types, each country's payout currency and
  cross-border minimum, and each bank account class's `routing_number` template come from
  `settings/payments-data.generated.json`; re-run `scripts/dump-payments-data.rb` when they change.
- **GeoIP (WS-75).** `infra/geo-ip.ts` is `GeoIp.lookup` over `lib/GeoIP2-City.mmdb` (mmdb-lib; nil without the file),
  used by `ip_country_code` here and the `events` row of the dashboard views. `infra/geo-ip.test.ts` replays
  `scripts/golden/geo-ip.rb` (47 addresses, odd forms included, over the maxmind-geoip2 gem's GeoLite2 test database in
  `infra/__fixtures__`). Rails' latitude and longitude are always nil (`santitize_string` `try(:encode)` on a Float).
- **What still throws `NotPortedError`**: the
  active-subscriber check of a seller whose Stripe Connect account routes sales; instant payouts for a seller
  who passes the first eligibility checks; the payout date of a rejected account that is not paused; a bank
  sync failure note and a verification error message; a profile with saved sections, a membership product,
  a reputation summary or an uploaded avatar (its `signed_id`).
- **Social connections.** `?social_connect_origin` writes the return token into the session from the
  page's `options.filters` (`controllers/settings-pages.ts`), after running the page's guard so that a
  refused request leaves the session alone.

## Partial reloads and merge props (WS-67)

`router.reload`/`router.visit` with `only`, `except` or `reset` (or `preserveUrl`) on the page the visitor is on do not
navigate: they GET the page's X-Inertia endpoint with `X-Inertia-Partial-Component/Data/Except` and `X-Inertia-Reset`,
and merge the answer into the held props as @inertiajs/core 2.3 does (`mergeProps` append, `prependProps`,
`deepMergeProps`, `matchPropsOn`; props the response leaves out keep their value), then move the URL with
`history.pushState`/`replaceState` unless `preserveUrl`. A reload with `data` but no `only` navigates to the new
query string. `lib/navigation/inertia-parity.test.ts` drives the real @inertiajs/core router and the compat router against
one server and compares headers, props and URL (skipped when the Rails app's node_modules is absent). The route must be
`"inertia": true`, since the request is answered by the `/gr-inertia` handler. `/followers` and
`/dashboard/utm_links` can be flagged on.

## Emails pages (WS-67)

`/emails` (301 to the scheduled or published tab, in the guard after `authorize`), `/emails/published|scheduled|drafts`,
`/emails/new` and `/emails/:id/edit` (flag `nextjs_emails`; GET renders only). Props in `server/page-props/emails/`:
`PaginatedInstallmentsPresenter` (SQL for the lists, Elasticsearch for `query`, search body in `installment-search.ts` proven by
`__fixtures__/installment-search.golden.json`), the non-workflow `InstallmentPresenter#props` (profile sections, delivery state read from
the blast's Redis keys, non-opener resends) and the form context. Parity: `spec/requests/emails_signed_in_spec.rb`, replayed by
`audience-pages.replay.test.ts`, which rebuilds the `installments` Elasticsearch index from each fixture's rows.

Throw `NotPortedError` (500): a post with attached files (`ProductFile#as_json`), a post without a name (`strip_tags` + `truncate`),
a `page`/`query` parameter that is an array or hash. A `quota_deferred_until` is a Redis timestamp the replayer does not move, so
`delivery.scheduled_for` is ignored in the comparison.

## Elasticsearch search (WS-65)

The query builders live in `src/server/search/`; each is a pure function returning the request body, proven against a golden recorded from the real Ruby through a recording TCP proxy in front of Elasticsearch 7.17 (`__fixtures__/es_recording_proxy.rb`, so the bodies are the bytes on the wire). Index names in the goldens are `ws65-*`; the tests compare bodies, not paths.

- `product-search.ts`, `search-products.ts`: `Product::Searchable` (`search_options`, `filetype_options`, `taxonomy_attribute_options`, `partial_search_options`) and the `SearchProducts` concern (param normalization, the facets of `search_products`, `TaxonomyAttribute` tokens). `discover-search.golden.json`, regenerate with `generate-discover-search-golden.rb`. `searchProductsWithFacets` returns the hit ids in order; loading the `Link` rows (`records`) is the caller's.
- `purchase-search.ts`: `PurchaseSearchService`, including the long-email-token fallback request. `purchase-search.golden.json`.
- `following.ts`, `civil-time.ts`: `CreatorAnalytics::Following` (time zone day starts, `D3` labels) and the `ConfirmedFollowerEvent` activity search. `following.golden.json`.
- Not ported: the Discover, `Products/Discover`, Customers, Audience, Churn, Analytics and Dashboard page renders. Discover needs `ProductPresenter.card_for_web`, `WishlistPresenter`, `RecommendedWishlistsService` and the `DiscoverSearch` write; the seller pages share `check_payment_details` (Redis plus a Stripe call) and the `DashboardPreference` after_action cookie, which `PageSpec` cannot set yet.

## Storefront pages (WS-68)

Seller subdomains and custom domains. Props and filters live in `server/page-props/storefront/` (`post-pages.ts`, `profile-pages.ts`), the
components are copies under `app/(app)/gr-host/seller/` (the proxy rewrites the path there for those hosts, see WS-64) and `blog/p/[slug]/`.
All of them are `signedOutOnly` in routes.json: a signed-in visitor (`can_edit`, the owner's own view, purchase-scoped posts) is Rails'.

| Route (flag) | Rails | Notes |
| --- | --- | --- |
| `seller:/p/:slug` (`nextjs_storefront_posts`) | `PostsController#show` | Fixtures: `storefront_posts_parity_spec`, `storefront_post_comments_parity_spec`. |
| `/blog/p/:slug` (`nextjs_gumroad_blog_post`) | `GumroadBlog::PostsController#show` | A post the policy refuses is the dashboard redirect with its flash. |
| `seller:/`, `seller:/subscribe`, `seller:/affiliates` (`nextjs_storefront_profile`) | `UsersController#show`, `#subscribe`, `AffiliateRequestsController#new` | Fixtures: `storefront_profile_parity_spec`. |

- **404 and hand-back live in `options.filters`**, not in `redirect`: a filter can throw `RoutingError` (404) or `HandBackToRails`, and both the proxy's envelope and the X-Inertia handler run it. `state` carries ids only (it travels in a request header), the props re-read the rows.
- **Host seller.** `storefront/seller-host.ts` is `set_user_and_custom_domain_config`: `Subdomain.find_seller_by_hostname || CustomDomain.find_by_host(host).user`, 404 unless `account_active?`. On these hosts `@is_user_custom_domain` is true, so `check_if_needs_redirect` never redirects.
- **Post visibility** for a visitor who is not signed in is `User#visible_posts_for` reduced to its public branch: the seller's alive, published, workflow-free audience posts shown on the profile. `recent_posts` is the same set minus the post; comments are roots (20 per page) plus their subtree down to `MAX_ALLOWED_DEPTH`, ordered by `created_at, id`.
- **Pinned to Ruby.** `__fixtures__/storefront-posts.golden.json` (`scripts/golden/storefront-posts.rb`): `time_ago_in_words` over every bucket and the leap-year rule, `PostPresenter#snippet`, `Installment#truncated_description` (`TextScrubber.format`, `squish`, `truncate`) and `Post::SocialImage`.
- **Handed to Rails** (decided in the filter): a `purchase_id` param, a post with files (`download_url` creates a `UrlRedirect`), a profile with a products section, the virtual default products section (a seller with a non-archived product and no sections), a featured product or wishlists section, a seller with custom HTML pages, an `affiliate_id`/`a` param (it writes a cookie), a generated subscribe preview image, the seller reputation summary, any non-HTML format. `/coffee` is not routed: it needs `ProductPresenter#product_props`.
- **Not ported: `ProductPresenter.card_for_web` and the products-section search.** The cards need the buyer's currency (GeoIP, WS-75), `thumbnail_or_cover_url` variants, `remaining_for_sale_count`, auto-applied offer codes and the Elasticsearch `search_products` for the section; WS-69 owns the product presenter, so `storefront/product-card.ts` is still to be written on top of it. Until then a profile that shows products is served by Rails.
- **Known differences.** `ProfileSectionsPresenter#cached_sections` is cached for ten minutes in Rails; the port reads the rows each time, so a profile edit shows at once instead of after the cache expires. `follow_recaptcha_site_key` reads `RECAPTCHA_FOLLOW_SITE_KEY`/`RECAPTCHA_MONEY_SITE_KEY` from the environment (`.env.test` for the replays).

## Product page and ProductPresenter (WS-69)

`/l/:id`, `/l/:id/:code` (Gumroad domain), `seller:/l/:id[/:code]` and `product:/`, `product:/l/:id[/:code]` (flag `nextjs_product_page`,
`"inertia": true`). `LinksController#show`'s before_actions are ported in Rails' order in `server/controllers/product-page.ts`
(`fetch_product_for_show` with `Link.fetch_leniently`, banned and deleted-seller 404s, `X-Robots-Tag` for a code, the affiliate cookie,
the 301 to the seller's host or canonical permalink, `ensure_domain_belongs_to_seller`, the coffee redirect). They are replayed by
`parity/__tests__/product-page.replay.test.ts` against `spec/requests/product_page_parity_spec.rb`: a 301, a 404 and the coffee 302 must match
Rails' status, headers and cookies; every request that would render must be handed back (a stand-in origin marks it).

**Handed back to Rails (`HandBackToRails`)**: every render of `Products/Show` (HTML and X-Inertia), custom HTML pages, `?format=`, nested params,
a deleted or Collaborator affiliate cookie that Rails resolves differently, and `product:/:code` (not in `routes.json`: it would shadow the other
product-domain routes). The render needs ~35 `product_props` fields (options and tiers, file info, covers, offer codes through
`BestOfferCodeService`, PPP and buyer currency through GeoIP, `purchase_info_for_product_page`), the product page meta tags with JSON-LD, and a
`Products/Show` client page under `app/gr-host/`, none of which exist in TypeScript yet.

**`server/presenters/product.ts`** is the canonical `ProductPresenter.card_for_web` (`cardForWeb(productId, options)`). It is proven by
`spec/presenters/product_presenter_golden_spec.rb` (`PARITY_GOLDEN=1`), which writes one database holding 32 product types and the real card
for six request shapes each, and `parity/__tests__/product-presenter.golden.test.ts`, which seeds that database and compares. Supported:
digital, PWYW, versions with price differences, physical (SKUs), call, commission, coffee, preorder, unpublished, adult, rated, limited,
refundable, non-USD, fixed-length, summary/attribute products, unsplash thumbnails, deleted. It throws `NotPortedError` for a tiered membership
(`lowest_tier_price`), a bundle's `remaining_for_sale_count`, a product with a default or seller-wide offer code, an uploaded thumbnail or cover
(Active Storage), a seller using buyer local currency (exchange rates), and a description outside the markup `description.ts` can prove
(`plaintext_description` is Loofah's `to_text`; `html_safe_description` covers attribute-less inline and heading markup only).

Not ported: `Wishlists/Show` (`WishlistPresenter#public_props` needs the card, `ProfilePresenter#creator_profile`, the discover nav and a client
page under `app/gr-host/`) and `Purchases/Product/Show` (`product_props` deep-merged with `PurchaseProductPresenter`, signed in only).

## Payouts and subscription management (WS-72)

GET renders only. `/payouts` (`nextjs_payouts`) and the access check of `/subscriptions/:id/manage` (`nextjs_subscription_manage`).
`/checkout` is not ported (see below) and has no route entry.

**Payouts** (`server/page-props/payouts/`). `BalanceController#index`, `PayoutsPresenter`, `UserBalanceStatsService#fetch_payout_periods` and
`PayoutsHelper#payout_period_data`:

- `payout-schedule.ts` is `User::PayoutSchedule` for the weekly, monthly and quarterly frequencies plus the date helpers of `PayoutsHelper`,
  proven against `__fixtures__/payout-schedule.golden.json`, recorded from the real module on a stub seller (`scripts/golden/payout-schedule.rb`:
  every day of 10 weeks x 3 frequencies x 3 payout rails x 5 balance shapes x paid-today). Dates are UTC (`Date.today` and `Date.current` agree
  in production).
- `payout-stats.ts` is the aggregates of `User::Stats` behind `payout_sales_data` (balances, PayPal and Stripe Connect sales by duration). A
  refund has no `tax_cents` column, so Rails' unqualified `sum(:tax_cents)` over refunds reads the purchase's: kept.
- `payouts-data.generated.json` (`scripts/dump-payouts-data.rb`) holds each bank account class's currency and `bank_account_type`, the payout rail
  weekdays and the legacy internal payout note prefixes; re-run it when they change.
- The filter (`pages.ts`) is `signedInFilters` plus `planPayouts`, which hands the request to Rails (`HandBackToRails`) for: daily payouts, a
  chargeback-rate payout reserve, a seller that passes the first instant payout checks (compliant, payouts not paused, US legal entity, a completed
  payout: Rails asks Stripe about the bank account), a seller whose balance stats are cached (`large_sellers` over the Redis threshold), a PayPal
  Connect account, a payout in a currency other than USD, a bank account class whose routing number cannot be derived, and a payout without a period
  end date. A page past the last one with no payouts raises Pagy's overflow (500), as Rails does. `payouts-handback.test.ts` covers these.
- Parity: `spec/requests/payouts_signed_in_spec.rb` (26 examples; run it with `TZ=UTC`), replayed by `parity/__tests__/checkout-payouts.replay.test.ts`.
  Past payouts show dates a whole number of days before the day of the request, so the recorder now stores `recordedOn` and the replay moves
  the recorded ordinal dates by the days since (`parity/src/date-drift.ts`). The upcoming payout's two date strings follow the payout cycle, not the
  day: they are left out of the replay and pinned by the schedule golden. The purchases index is created empty for the sales totals of the shared props.

**Subscription management** (`server/controllers/subscription-pages.ts`, `page-props/buyer/subscription-manage.ts`). `SubscriptionsController#check_can_manage`:
`set_noindex_header`, a 404 for an unknown or ended subscription and for an installment plan whose charges are all collected, the encrypted
`subscription_<numeric id>` cookie, a team member, the owner or the gifter, and the `token` parameter (valid: allowed; wrong or expired: redirect to the
magic link page with `invalid=true`; none: redirect without it). The refusals are replayed (`spec/requests/subscriptions_manage_access_spec.rb`). A
visitor who may manage, and a JSON request or an impersonation, go to Rails: `CheckoutPresenter#subscription_manager_props` (tier and recurrence
prices from `Variant#to_option`, proration, offer code and plan-change discounts, Stripe and PayPal payment method state, `Checkout::StripePaymentPresenter`
flags) and the confirmation cookie it writes are not ported. `Subscriptions/Manage` has no component copy: reaching `page.tsx` throws `NotPortedError`.
`Subscriptions/MagicLinks/New` was ported in WS-61.

**Checkout** (`CheckoutController#show`) is not ported. It needs `CartPresenter` (cart products, offer-code discounts through
`OfferCodeDiscountComputingService`, `BestOfferCodeService`), `CheckoutPresenter#checkout_product` for every cart and arrival item (`ProductPresenter`
pieces, PPP and buyer currency display, shipping countries, custom field descriptors, upsells and cross sells, bundle products, wishlist and gift
arrivals, restart intent tokens), `Checkout::StripePaymentPresenter` (720 lines of lane selection over Flipper flags and currency eligibility),
`CheckoutRecaptcha`, `TipOptionsService`, GeoIP and `process_cart_id_param` (which merges carts). The `recommended_products` prop needs
`RecommendedProducts::CheckoutService` and `ProductPresenter.card_for_web`.

## Agent, piracy reports, dispute evidence and the invoice redirect (WS-75)

GET renders only; recorded by `spec/requests/{agent,piracy_reports,dispute_evidence}_signed_in_spec.rb` and
`generate_invoice_redirect_spec.rb`, replayed by `parity/__tests__/ws75-pages.replay.test.ts`.

- **Flags**: `nextjs_agent` (`/agent`), `nextjs_piracy_reports` (`/dashboard/piracy_reports`, `/new`, `/:id`),
  `nextjs_dispute_evidence` and `nextjs_dispute_evidence_success` (`/purchases/:purchase_id/dispute_evidence[/success]`),
  `nextjs_generate_invoice_redirect` (`/purchases/:purchase_id/generate_invoice`).
- **Agent** (`page-props/agent/pages.ts`): the role gate is `userPolicy.viewStoreAgent`; `eligible` is the store-agent
  predicate the shared props already use. A seller who has earned access (the Elasticsearch sales aggregate) is covered by the
  `purchase-sales` golden, not by a replay.
- **Piracy reports** (`page-props/piracy-reports/pages.ts`): `set_product`/`set_report` run before `authorize`, as in Rails, so
  an unknown product or report redirects to `/products` for any role. `PiracyReports::Eligibility` is read in SQL; the replays leave
  the Elasticsearch-backed earned-access bar unmet.
- **Dispute evidence** (`page-props/dispute-evidence/pages.ts`): the filters are `authenticate_user!`, `set_purchase`
  (`SecureExternalId` token first, then the external id; `models/secure-external-id.ts` gained `decryptSecureExternalId`),
  `set_dispute_evidence` and `check_if_needs_redirect`; the props reload the records from the route param because the filter
  state travels in a header and must stay small. The hours left and the deadline depend on whether the 72 hour window touches a
  weekend, so the replay ignores those props (the window arithmetic has its own golden).
  `NotPortedError`: a buyer-currency presentment on the disputed purchase or charge (`StripeChargeProcessor.format_charge_presentment_amount`).
- **generate_invoice** is a Rack-level `redirect`, so it is an App Router route handler (`route.ts`) with the middleware headers and
  none of the controller's cookies. Known difference: a query string with literal `[]` comes back percent-encoded, because Next
  normalizes `request.url`.
- **Not converted here** (Communities and the unavailable url redirect pages are in the WS-81 section; the rest is listed there too):
  `Purchases/Invoices/New` and the `UrlRedirects` download, stream, read and play pages.


## Seller products pages (WS-71)

GET renders only; every mutation (create, update, archive, duplicate, delete, publish) stays in Rails. Props live in `server/page-props/seller-products/`, the controllers' filters in `server/controllers/seller-products-pages.ts`, the policies in `server/policies/link.ts`. Parity: `spec/requests/seller_products_{signed_in,affiliated_signed_in,new_signed_in,collabs_signed_in}_spec.rb`, replayed by `parity/__tests__/seller-products.replay.test.ts` (an empty `purchases` index stands in for Elasticsearch); the Elasticsearch request bodies are pinned to the ones Rails sent in those fixtures by `seller-products/es-requests.test.ts`.

| Route (flag) | Rails | Notes |
| --- | --- | --- |
| `/products` (`nextjs_products_index`) | `LinksController#index` | Tables are deferred props (below). |
| `/products/archived` (`nextjs_products_archived`) | `Products::ArchivedController#index` | A seller with nothing archived (and no search) goes back to `/products`. |
| `/products/affiliated` (`nextjs_products_affiliated`) | `Products::AffiliatedController#index` | The sort travels as `sort[key]` / `sort[direction]`: `SignedInPage.nestedQuery`. |
| `/products/collabs` (`nextjs_collabs`) | `Products::CollabsController#index` | Per-product Elasticsearch sums (`collabs.ts`). |
| `/products/new` (`nextjs_products_new`) | `LinksController#new` | `ProductPresenter.new_page_props`. |

- **Deferred props.** `InertiaRails.defer(group:)` is `defer(resolve, group)` in `lazy-props.ts`: left out of the first response, listed under `deferredProps` (page object key order: after `clearHistory`, before `mergeProps`) and answered to a partial reload that asks for them. The client half is in `PagePropsProvider`, which issues `router.reload({ only })` for each group once the page is set, as Inertia 2 does.
- **Handed back to Rails (`HandBackToRails`, decided in the filter before anything renders).** A seller flagged in `user_ids_with_payment_requirements_key` (`check_payment_details` may call Stripe); a sort Elasticsearch performs (`display_price_cents`, `is_recommendable`) or `cut` on the collabs page; a page parameter `String#to_i` and Pagy would read differently; a product on the page without a fresh `ProductCachedValue` (Rails computes its stats from Elasticsearch and enqueues `CacheProductDataWorker`); a currency other than USD, a rental, a tiered membership with a tier closed to new buyers (`can_close_to_new_buyers?`); an uploaded thumbnail (Active Storage variant); a confirmed collaborator without basis points; `display=mobile_app` or `access_token` on `/products/new`; a global affiliate whose lifetime sum does not finish within `AffiliateEarningsCache::REQUEST_TIMEOUT_MS`.
- **Known differences.** `AffiliateEarningsCache` serves a cached sum for up to five minutes and keeps it in `Rails.cache`; the port always reads the current sum and caches nothing. `Rails.env.development?` branches of `User#can_create_physical_products?` / `#eligible_for_ai_product_generation?` are not modelled. `release_at_date` (one month from today) is checked by `new-page.test.ts`, not by the replay.
- **Not ported: `Products/Edit`** (`LinksController#edit` -> `ProductPresenter#edit_props`: editor revision, rich content, files, integrations, variants and their prices, shipping, upsells, share tab, plus `bundles/:id/edit`). It has no entry in `routes.json`; the `nextjs_products_edit` flag is unused.

## Seller product editor (WS-80)

`/products/:id/edit` and its tab routes `/products/:id/edit/*other` (`nextjs_products_edit`, `LinksController#edit` -> `ProductPresenter#edit_props`); GET renders only. Props in `server/page-props/seller-products/edit.ts`, the guard in `seller-products/pages.ts` (`productsEdit`), the policy is `linkPolicy.edit`. Parity: `spec/requests/seller_products_edit_signed_in_spec.rb` (16 fixtures: tabs, the Inertia visit, a draft with custom settings, a product-level refund policy, profile sections and name suggestions, taxonomies, the seller's time zone, a bundle redirect, 404, admin/marketing/support/accountant, signed out), replayed by `seller-products.replay.test.ts`. `Product::EditorRevision` is pinned by `__fixtures__/editor-revision.golden.json` (`spec/services/product/editor_revision_golden_spec.rb`, `PARITY_GOLDEN=1`); the replay ignores the HMAC and the env-derived `s3_url`, `aws_key`, `google_client_id` and `dropbox_api_key`.

- **What renders in Node.** A plain digital, course or ebook product (any currency, draft or published) that nobody else touches. Every tab is the same action, so every tab renders from the same props. `matchPagePath` learned `*name` globs for the tab routes.
- **Handed back to Rails (`editBlockers`, decided in the guard).** Any other native type (membership, physical, call, coffee, commission, bundle contents) or a recurring, tiered, physical, pre-order, free-trial, SKU or collab flag; a purchase limit, default offer code or subscription duration; the editor being opened by a collaborator or another seller; and any live row in a table the port does not read: covers, thumbnail, files, rich content, versions, SKUs, integrations, shipping destinations or exclusions, tags, a collaborator, a custom-HTML page, a product or seller custom domain, an installment plan, public files, a waitlist, product builds, sales, reviews; a seller who owns any product file (the picker lists the whole library), a product-level refund policy on another product, no account refund policy row, a taxonomy attribute whose values are not an array; a seller without a `marketing_holdout_assignments` row (`HoldoutAssignment.for_seller!` inserts it); `access_token` or `display=mobile_app`. `edit.test.ts` pins each predicate.
- **Not authorized.** `PunditAuthorization#product_edit_user_not_authorized`: a seller or role that may not edit goes to the product page (`/l/:permalink`), not the dashboard.
- **Bundles.** `LinksController#edit` redirects a bundle to `/bundles/:id/product/edit`; the port sends the same redirect. `bundles/:id/edit` and its three tabs (`nextjs_bundle_edit`, `BundlePresenter`) are not ported and have no `routes.json` entry.
- **Known differences.** `Discover::TaxonomyPresenter#taxonomies_for_nav` is read fresh; Rails keeps it in `Rails.cache` for an hour. `LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY` is read in UTC.
- **Not ported.** Everything in the hand-back list: `files_data`/`existing_files`, `PublicFilePresenter`, variants and tiers with their price rows, `rich_content_json`, covers and the thumbnail variant, integrations, shipping, `WaitlistLaunchEmail`, collaborators and custom domains. Each needs its own goldens before its predicate can go.

## Seller dashboards backed by Elasticsearch (WS-70)

`/dashboard/audience` (`nextjs_audience`), `/dashboard/churn` (`nextjs_churn`) and `/dashboard/sales` (`nextjs_analytics`); GET renders only. Props in `server/page-props/analytics/`, registered by `analytics/pages.ts`. Parity: `spec/requests/{audience_dashboard,churn,analytics,seller_payment_details}_signed_in_spec.rb`, replayed by `parity/__tests__/dashboard-pages.replay.test.ts`.

- **Shared mechanisms.**
  - `ActionOptions.afterCookies` is the cookies the action's `after_action`s write (`DashboardPreference`: `last_viewed_dashboard`). They are written ahead of `XSRF-TOKEN` and only when the chain was not halted (`rescued`).
  - `defer`/`always` (`lazy-props.ts`) are `InertiaRails.defer` and `InertiaRails.always`. A deferred prop is left out of a first load and listed in `deferredProps`; a server render starts it through `InertiaPage.deferredLoaders` and streams it, a partial reload of the component gets it, and `always` props survive the partial-reload filter.
  - `sellerGuard` takes `beforeAuthorize` (the controller's own filters between `authenticate_user!` and `authorize`) and `afterAuthorize`.
  - A guard may throw `HandBackToRails`: the preflight sends such a request to the handler, which forwards it to Rails whole.
- **`check_payment_details`** (`audience/payment-requirements.ts`): the Redis set is read as Rails reads it (a Redis error reads as "no requirements"). A flagged seller with a live Stripe merchant account is handed to Rails, because Rails then either redirects to the payments settings (a requested compliance request) or calls `Stripe::Account.retrieve`, an outbound HTTP request the port does not make. `seller_payment_details_signed_in_spec` records the Stripe call (`http` in the fixtures); the replay checks that the request reaches Rails.
- **Large sellers go to Rails.** `LargeSeller.create_if_warranted` writes a row at 1000 sales, and a large seller's churn and sales ranges are read from and written to `ComputedSalesAnalyticsDay`. Churn and Analytics hand such a seller back (`handBackLargeSeller`); the cache reads and writes are not ported.
- **Date ranges.** `DateTime.parse`/`Date.parse` of a `from`/`to` param is ported for ISO dates and datetimes, and for strings with neither a digit nor a day or month name (Ruby raises, the action rescues, the default range applies). Any other string is handed back.
- **Elasticsearch.** Churn's four queries (`analytics/churn.ts`) are the composite aggregations of `CreatorAnalytics::Churn::ElasticsearchFetcher` over `PurchaseSearchService`'s query; the Audience chart is `CreatorAnalytics::Following`. `search/creator-analytics-sales.ts` is `CreatorAnalytics::Sales`. The churn fetcher and Sales are pinned to the request bytes and answers Ruby produced (`search/__fixtures__/creator-analytics.golden.json`, regenerate with `generate-creator-analytics-golden.rb`). The replay rebuilds the indices the server searches (under `ES_INDEX_SUFFIX`): `purchases` from the seeded rows with the port's own `PurchaseRecord.asIndexedJson`, and `confirmed_follower_events` (which has no table) from the documents the recorder snapshots into each exchange's `elasticsearch` key. A fixture's query dates are recorded as `<today-3d>` tokens and resolved by the replayer.
- **Sales analytics.** `AnalyticsPresenter#page_props` and `CreatorAnalytics::HourlySalesCurve` (with its `Rails.cache` entry). `analytics-data.generated.json` (`scripts/dump-analytics-data.rb`) holds the country-name map and the states list. The fraction of the day follows the request's clock, so the replay ignores it and checks that the curve the port builds from the seeded sales yields the recorded fraction for some time of day. The charts call `/analytics/data/by_date|by_state|by_referral`, which stay in Rails: `CreatorAnalytics::CachingProxy`, `Web`, `ProductPageViews` and the `Formatters` are not ported.
- **Not ported.** The seller dashboard home (`/dashboard`: `CreatorHomePresenter`, `UserBalanceStatsService`, tax forms, `SocialConnectFunnel.record_offers!`, the `LargeSeller` write and a session write) and Customers (`/customers`: `CustomerPresenter` and the Purchase readings it makes (`displayed_price_cents_before_offer_code`, `amount_refundable_cents_in_currency`, `ppp_info`, `display_referrer`, `transaction_url_for_seller`, licenses, reviews, commissions, calls), and the `fetch_sales` filters of `CustomersController`) stay in Rails; neither is in `routes.json`. `PurchaseSearchService` and `CreatorAnalytics::Sales` are ready for them.

## Communities, url redirect unavailable pages and what is left of invoices and downloads (WS-81)

GET renders only. Parity: `spec/requests/communities_signed_in_spec.rb` (replayed by `parity/__tests__/communities.replay.test.ts`, 14 fixtures) and
`spec/requests/url_redirect_unavailable_pages_spec.rb` (`url-redirect-pages.replay.test.ts`, 16 fixtures).

- **Flags**: `nextjs_communities` (`/communities`, `/communities/:seller_id/:community_id`, signed-in only), `nextjs_url_redirect_expired`,
  `nextjs_url_redirect_rental_expired`, `nextjs_url_redirect_membership_inactive` (`/r/:id/...`) and `nextjs_url_redirect_confirm` (`/confirm`).
- **`InertiaRails.scroll`** (`lazy-props.ts` `scroll(metadata, resolve)`, read from inertia_rails 3.15's `ScrollProp`/`ScrollMetadata`): a merge prop that
  lands in `mergeProps`, or in `prependProps` when `X-Inertia-Infinite-Scroll-Merge-Intent` is `prepend`, and in `scrollProps`
  (`pageName`, `previousPage`, `nextPage`, `currentPage`, `reset`). A reset prop keeps its `scrollProps` entry (`reset: true`) but is in neither merge list.
  The metadata is evaluated whenever the props are resolved, as the action builds it eagerly. Page key order: `deferredProps`, `scrollProps`,
  `mergeProps`, `prependProps`.
- **`<InfiniteScroll>`** (`lib/navigation/infinite-scroll.ts`, `components.tsx`): core's `useInfiniteScroll` (data, elements, query string and scroll
  preservation managers) and the React component, over the compat router. The router gained `onBeforeUpdate`, `remember`/`restore`, and the page
  carries `scrollProps` (merged over the held ones after each in-place response). `inertia-parity.test.ts` drives the real `@inertiajs/core` router and the
  compat one through append, prepend and reset reloads of a scroll prop and expects the same requests, props and `scrollProps`. The component itself
  (IntersectionObserver triggers, scroll restoration) is a port of core's code and has not been exercised in a browser.
- **Communities** (`page-props/communities/`): `CommunitiesPresenter`, `CommunityPresenter`, `CommunityChatMessagePresenter`,
  `CommunityNotificationSettingPresenter`, `PaginatedCommunityChatMessagesPresenter`, `Community#thumbnail_url`, `accessible_communities_ids` (already in
  `models/community.ts`) and `has_accessible_communities?`. The cursor reaches MySQL as the string the client sent. The unread counts are a count per community
  instead of the `JOIN (VALUES ...)` statement (same numbers). The page component is the Rails app's own (`$app/pages/Communities/Index`), so the chat
  (posting, edits, read markers, notification settings, the cable channel) keeps calling Rails. `@anycable/web` joined `sharedPackages`.
- **Parity harness**: a query parameter holding a UTC time (`cursor=2026-...Z`) is recorded as a time token and resolved by the replayer, which now
  works in whole seconds. Time tokens round to the minute from 60 s and to the hour from a day, so a spec that needs ordered rows keeps them a minute apart
  and under a day old.
- **Unavailable url redirect pages** (`page-props/url-redirects/`): `UrlRedirectPresenter#download_page_without_content_props` for `fetch_url_redirect`
  alone (no `check_permissions`, no after_actions: these pages write nothing). Handed back to Rails (`HandBackToRails`, decided in the filter): a redirect
  that hangs off an installment or an imported customer, a purchase with a product review, a call, a post-purchase custom field, a bundle product purchase
  or a gift sender purchase, more than one purchased variant, and `/confirm` without `destination` when the product (or a variant, or a commission) has
  rich content (Rails would default the destination to `download_page`).
- **Not converted: `Purchases/Invoices/New`.** `InvoicePresenter::OrderInfo` reads `ReceiptPresenter#payment_info`/`#charge_info`
  (`today_price_attributes`, tax rows, payment method, formatted dates and totals, presentment currency) and `Charge::Chargeable`; WS-76 owns the
  `ReceiptPresenter` port (`mail/mailers/receipt-presenter.ts`, unmerged when this was written). Port `OrderInfo`/`SupplierInfo`/`FormInfo` on top of it
  once it is merged, with goldens from the real presenters.
- **Not converted: the download page (`/d/:id`), stream, read and play.** They need `check_permissions` (a dozen redirects and the confirmed-redirect
  cookie), `download_page_with_content_props` (files, folders, subtitle files with signed S3 URLs, rich content, posts, discord, community URL), and the
  after_actions: `register_that_user_has_downloaded_product` (`uses` increment, `mark_as_seen`, the encrypted `confirmed_redirect` cookie),
  `create_consumption_event!` and the file lifecycle events (`update_transcoded_videos_last_accessed_at`, the regeneration jobs). None has a golden yet.

## Product page render (WS-77)

`Products/Show` is served from Node on `/l/:id[/:code]`, `seller:/l/:id[/:code]` and `product:/`, `product:/l/:id[/:code]` (same flag, `nextjs_product_page`, no new routes). The client page is `app/(app)/l/ProductsShow.tsx`, mounted by `l/[id]`, `gr-host/seller/l/[id]` and `gr-host/product/**` with `InertiaShell clientOnly`: `Product/index.tsx` creates DOM nodes while rendering, which Rails never did on the server either.

- **How a request is decided.** `presenters/product-page.ts#assertRenderable` runs at the end of the `LinksController#show` filters (`controllers/product-page.ts`). It builds the whole page once (props, meta tags, JSON-LD) and turns a `NotPortedError` into `HandBackToRails`, so a visitor either gets a page proven against Rails or Rails' own answer. The props build it again (the proxy envelope and the page render are separate requests). `PRODUCT_PAGE_DEBUG=1` logs why a page was handed back.
- **Props** (`presenters/product-props.ts`): `ProductPresenter::ProductProps#props` for visitors who are not signed in and for a seller or team member looking at their own product (`can_edit`, the editor's `products`/`posts`/`wishlist_options`): options (variants, SKUs, tiers with `recurrence_price_values`), recurrences, rental, preorder, installment plan, file info (`human-size.ts`), ratings (`rating_percentages`), refund policy (`simple_format` of plain text), analytics, third-party analytics, bundle products and bundle inventory, the ES sales count (`PurchaseSearchService`, read fresh instead of through the one-minute `Rails.cache`), the seller byline with the custom domain, and `BestOfferCodeService` for a code in the path or `?code=` plus the seller's auto-applied sale (`best-offer-code.ts`: `OfferCodeDiscountComputingService` for one product and no buyer, usage limits and the `inactive`/`sold_out` errors included). Meta tags and JSON-LD are `PageMeta::Product` and `Product::StructuredData`.
- **Parity.** `spec/requests/product_page_parity_spec.rb`, replayed by `parity/__tests__/product-page.replay.test.ts`. `RENDERED` lists the fixtures the port renders byte for byte (status, headers, cookies, the Inertia page); every other request that would render must reach the stand-in origin. The replay rebuilds a `purchases` index under `ES_INDEX_SUFFIX` from the seeded rows, so the sales-count example indexes its purchase in the spec.
- **Routing fix.** `seller:/` and `product:/` both match a custom domain's root. The proxy took the first match and let the host gate send the request to Rails when the gate said "product"; `decideRoute` now walks every match (`matchRoutes`) and takes the first one the gate accepts.
- **Handed back to Rails** (a `NotPortedError` inside `assertRenderable`, or a parameter in it): `layout`, `embed`, `overlay`, `wanted`, `purchase_id`, `offer_code`, `debug` and `currency` parameters; a discover click (`recommended_by=search|discover` writes a `DiscoverSearch`); a visitor with a purchase of the product (`Purchase#purchase_info`: review, membership, content URL, license) or a wishlist (`WishlistPresenter#listing_props`); covers (`AssetPreview#as_json`, Active Storage), public files, uploaded thumbnails; a collaborator; a call product (the page head preloads the calendar through the Vite manifest); an ebook (`Book` JSON-LD); a seller with the reputation summary or the storefront product page on (`Products/Profile/Show`); product sections; a waitlist; PPP for a country with a factor below 1; buyer local currency; a non-USD product (JSON-LD converts to USD); a product with a default offer code, a code limited to options, once-per-cart, tiered or customer-restricted, or a URL code competing with a default code; markup `description.ts` cannot prove.
- **Not ported.** `Products/Iframe/Show`, `Products/Profile/Show`, `Products/Discover/Show`, `?wanted=true` (the checkout redirect), `/coffee`, `Wishlists/Show`, `Purchases/Product/Show`, the JSON API (`?format=json`).

## Large-seller analytics and the profile products sections (WS-84)

**Large sellers.** `models/large-seller.ts` (`LargeSeller.create_if_warranted`: no row, 1000 purchase rows of any kind, then one insert) and `models/computed-sales-analytics-day.ts` (`read_data_from_keys`, `fetch_data_from_key`, `upsert_data_from_key`, `create_or_find_by!`) replace the hand-back of WS-70. `/dashboard/sales` and `/dashboard/churn` call `createLargeSellerIfWarranted` in the guard (after `authorize`, before the props), and Churn reads and writes its payload cache (`creator_analytics_churn:payload:v<version>:seller_<id>:<timezone>:<from>:<to>`; ranges that ended at least two days ago; `churn_rate` is stored as a Ruby Float, `1.0`).

**Analytics data endpoints** (`nextjs_analytics_data`, `signedInOnly`): `/analytics/data/by_date|by_state|by_referral`, `server/controllers/analytics-data.ts` over `processAction` with `Rendered` JSON. `set_time_range` accepts ISO dates and datetimes (a trailing "(location)" is stripped); anything else Ruby might read differently, or a repeated or nested param, is Rails'. `page-props/analytics/`: `creator-analytics-web.ts` (`CreatorAnalytics::Web`), `caching-proxy.ts` and `caching-proxy-formatters.ts` (`CachingProxy#data_for_dates` and the three `merge_data_by_*`), `search/product-page-views.ts` (`CreatorAnalytics::ProductPageViews`), `search/d3.ts` (`D3`). The hourly referral view bypasses the cache, as in Rails. Midnights that do not exist (a DST change at 00:00) are handed back.
- Parity: `spec/requests/analytics_data_signed_in_spec.rb` and `large_seller_dashboards_signed_in_spec.rb`, replayed by `parity/__tests__/analytics-data.replay.test.ts`. **The specs freeze the clock** (`travel_to`), because the answers hold calendar labels and the cache keys are made of dates; the replay moves its own clock (`vi.useFakeTimers`, Date only) and the server's (`parity/src/fixed-clock-preload.cjs`, `PARITY_CLOCK_OFFSET_MS`) to the same instant. The recorder now snapshots `ProductPageView` documents too (like `ConfirmedFollowerEvent`, there is no table behind them) and the replay rebuilds `product_page_views` from them and `purchases` from the rows.
- Not ported: `generate_cache` / `overwrite_cache` (the `GenerateLargeSellersAnalyticsCacheWorker` and `RegenerateCreatorAnalyticsCacheWorker` jobs stay in Ruby), the `group_*_data_by_day|month` formatters (mobile API, MCP), `SalesAndTraffic` (no such class exists in the app). The 1000-sale boundary of `create_if_warranted` is pinned by `large-seller.test.ts`: a fixture of 1000 purchase rows is ten megabytes.
- Known differences: product permalinks that are only digits would be serialized first by JavaScript objects; a country-less view (`nil` hash key, `""` in JSON) merged with cached days that already hold `""` would print a duplicate key in Ruby.

**Profile products.** `page-props/storefront/product-sections.ts`: a `SellerProfileProductsSection` and the virtual default products section (a seller with no sections and a non-archived product; the tabs become one `Products` tab) are served for visitors who are not signed in: `search_products` (WS-65) with `is_alive_on_profile` and the section as `shown_products`, then `cardForWeb` per product with `target: "profile"`, `show_seller: false`, no description or inventory, and sold-out products that hide their sold-out state left out (the total shrinks). Parity: `spec/requests/storefront_profile_products_parity_spec.rb`, replayed by `storefront-profile-products.replay.test.ts` (the `products` index is rebuilt from the seeded rows with the port's own `ProductRecord`).
- Handed to Rails, decided in the filter by rendering the sections once ahead of the page: a card `cardForWeb` refuses (`NotPortedError`: tiered membership, auto-applied offer code, uploaded thumbnail, buyer local currency...), any of the visitor search params (`query`, `tags`, `sort`, ...), a featured product section (needs `ProductPresenter#product_props`, WS-77) and a wishlists section (`WishlistPresenter`). `/coffee` is still not routed.
- Known difference: `ProfileSectionsPresenter#cached_sections` is cached for ten minutes in Rails; the port searches on every request.

## Checkout page (WS-78)

`GET /checkout` (`nextjs_checkout`, `"inertia": true`, signed in or out; `CheckoutController#show`, `Checkout/Show`). Props in `server/page-props/checkout/`,
filters in `server/controllers/checkout-pages.ts`, client page `checkout/CheckoutShow.tsx` (a copy of `pages/Checkout/Show.tsx`; it adds `braintree-web` and
`@paypal/paypal-js` to the shared packages).

**Rendered by the port**: a cart that holds nothing (no cart, a guest cart without visible lines, a deleted cart, an alive empty cart) on a URL that adds
nothing: `cart` (`CartPresenter#cart_props` with no lines: email, return URL, PPP flag), `checkout` (`checkout_common` from `checkout-data.generated.json`
dumped by `scripts/dump-checkout-data.rb`, GeoIP country and US/Canada region, the account's country, state, address and saved card, `CheckoutRecaptcha`
with the `recaptcha_score_checkout` Flipper cohort, `TipOptionsService` from Redis), `checkout_payment` (`Checkout::StripePaymentPresenter` answers the
constant `card_element` / `empty_cart` shape before reading any seller) and `stripe_fonts_css_source`. `CheckoutController#analytics_enabled?` is always true
(`PageSpec.analyticsEnabled`).

**`process_cart_id_param`** is ported up to its only write: a signed-in buyer, an unknown, deleted or wrong-scope id, a cart whose browser already holds it, and
a cart that belongs to an account (login redirect with the flash) answer like Rails (`rescued`, so no XSRF cookie). A guest cart for another browser (the
`MergeCartsService` merge) goes to Rails before anything is written.

**Handed back to Rails (`HandBackToRails`)**: a non-HTML format; a nested query; `product`, `wishlist` or `gift_wishlist_product` params; a cart with a visible
line (`checkout_product`, `OfferCodeDiscountComputingService`, the lane selection of `StripePaymentPresenter`) or a stored discount code; a partial reload that
asks for `recommended_products`. Not started: `CheckoutPresenter#checkout_product` for cart and arrival items (PPP, buyer currency, bundles, memberships, gifts,
upsells and cross sells), `BestOfferCodeService` defaults, `RecommendedProducts::CheckoutService`, `Checkout::RestartIntentToken`.

Parity: `spec/requests/checkout_parity_spec.rb` (35 examples) replayed by `parity/__tests__/checkout.replay.test.ts` (30 compared against Rails' status, headers,
cookies and `data-page`/JSON props; 5 must reach the stand-in origin). `GeoIp.lookup` is un-mocked in the spec and pointed at the GeoLite2 test database
(`GEOIP_DATABASE_PATH` in the replay); the replay sets the two reCAPTCHA keys the spec stubs. IPs travel as `X-Forwarded-For`.

**`Subscriptions/Manage` props** stay unported (see WS-72): `subscription_manager_props` needs `Variant#to_option`, proration, plan-change discounts and
`Checkout::StripePaymentPresenter` over a real cart shape.

## Mutations of pages (WS-82)

A POST/PUT/PATCH/DELETE served by Node is a route keyed with its method in routes.json (`"PATCH /workflows/:id": { "flag": ..., "mutation": true, "signedInOnly": true }`).
The proxy rewrites it to `/gr-mutation` (`app/gr-mutation/route.ts`, `server/controllers/mutation.ts`), which registers actions with `registerMutations` and runs them through
`processAction`, so the filters, session, flash, `XSRF-TOKEN` and SecureHeaders are the ones of a page request.

- **Hand-back.** Before the chain runs, a request Rails would treat differently goes to Rails with its body: a format that is not HTML (Pundit answers 401 JSON), a
  per-form or missing CSRF token or a foreign Origin (Rails runs the action with a null session), a body that is not JSON or a simple form, a nil inside a list
  (`deep_munge`). Inside the action a `NotPortedError` (thrown before the first write of its transaction) becomes the same hand-back and is logged as `[mutation] ... handed back`.
- **CSRF** follows `verified_request?` for the global token: `X-XSRF-TOKEN` (copied to `X-CSRF-Token` by InertiaRails::Middleware when the request is Inertia),
  `X-CSRF-Token` or `authenticity_token`, masked or not.
- **Responses.** A redirect after PUT/PATCH/DELETE with `X-Inertia` is 303 (the middleware); `redirect_to ..., inertia: { errors: }` is `Redirected.inertiaErrors`, written to
  the session and shown by the next render; a redirect with any status other than 301/302 clears errors left in the session. `railsSegment` writes ids as Rails' path
  helpers do (the `=` of an external id stays).
- **Versions.** `withPaperTrailRequest` carries `whodunnit` (the signed-in user) and `controllerInfo`; `remote_ip` is the rightmost public `X-Forwarded-For` entry and
  `request_uuid` the `X-Request-Id`. Rails' test environment disables PaperTrail, so replays do not compare `versions` rows (the goldens pin them).
- **Parity.** `spec/requests/{emails,workflows}_mutations_signed_in_spec.rb` (38 recorded requests: success, validation errors, 404s, policy refusals for support and
  accountant, marketing allowed) replayed by `parity/__tests__/audience-mutations.replay.test.ts` against `next dev` with a stand-in Rails that must receive the hand-backs.
  The replay compares status, redirect, cookies, every row written and every job (BullMQ jobs read back as their Sidekiq items). Ignored: `updated_at` of a row touched in the
  same second as its seed, `jobs.*.at` (normalized to a bucket), the random uuids of a slug suffix and of schedule intents. Flags: `nextjs_emails_writes`, `nextjs_workflows_writes`.
  Record with the default ObfuscateIds key of `.env.test` and a recording database apart from the replay's: the replay truncates its database.
- Not ported: `PATCH /workflows/:id/emails` (`Workflows::EmailsController#update`), the preview and send actions of `/emails`, and the other JSON endpoints.

## Discover (WS-83)

`/discover` and the taxonomy pages `/*taxonomy` (flag `nextjs_discover`, `"inertia": true`); `DiscoverController#index` -> `Discover/Index`. Props in `server/page-props/discover/` (`discover.ts`, `taxonomies.ts`, `pages.ts`), the filters in `server/controllers/discover-page.ts`, the SEO presenters (`Discover::CanonicalUrlPresenter`, `TagPageMetaPresenter`, `CategoryPagePresenter`, `UrlService.discover_full_path`) in `presenters/discover/seo.ts` over `discover-data.generated.json` (`scripts/dump-discover-data.rb`: the taxonomy labels, `config/discover_meta_tags.yml`, the bot user agents, the single-unit currencies). Parity: `spec/requests/discover_parity_spec.rb` (22 examples, signed out and signed in), replayed by `parity/__tests__/discover.replay.test.ts`, which rebuilds the `products` index (under `ES_INDEX_SUFFIX`) from the seeded rows with the port's `ProductRecord.asIndexedJson`.

- **`/*taxonomy` is a catch-all, so it carries a `pathGate`.** `routes.json` marks it `"pathGate": "taxonomy"`: the proxy matches such a route after every other and only serves it when `RouteGate.taxonomyPath` says the request is on the discover host and its path is a taxonomy's (`server/discover-taxonomy.ts`, `DiscoverTaxonomyConstraint`; Rails memoizes the list per process, the port reads the table). A gate that cannot tell leaves it to Rails. `matchPagePath` supports `*glob` segments, also last.
- **Handed to Rails (`HandBackToRails` in the filter).** Every partial reload of the deferred props (`recommended_products` is a random sample cached for a day, `recommended_wishlists` needs `WishlistPresenter`, `recently_viewed` reads `product_page_views` behind a Flipper experiment), the autocomplete request (`Discover::AutocompletePresenter` and its `DiscoverSearch` write), a visitor with a cart or a purchase (the curated products come from `RecommendedProducts::DiscoverService`), the Black Friday feature (`BlackFridayStatsService`), an `affiliate_id`/`a` param (cookie write), a nested query (`tags[]=`), and any card `cardForWeb` refuses (it throws `NotPortedError`: tiered memberships, bundles, default offer codes, uploaded thumbnails, local-currency sellers). The deferred props are therefore placeholders that throw `NotPortedError`: the client's follow-up request never reaches them.
- **`DiscoverSearch` write** (`createDiscoverSearch`): the `store_discover_searches` Flipper gate keyed by the guid, the bot check (`ApplicationController#is_bot?`), `discover_searches` and, for a non-blank query, `discover_search_suggestions`, in one transaction. Proven by the `db` diff of the fixtures.
- **Known differences.** `taxonomies_for_nav` is cached by Rails for an hour; the port reads it each time. Equal sort keys (the same slug and sales count under two parents) keep id order, where Ruby's `sort_by` is unspecified. The crawl fallback (`discover/_seo_links.html.erb`: category and pagination links in a `<noscript>`) is not rendered by the Next layout. A search request makes its Elasticsearch calls and builds the cards twice (once in the filter, which decides the hand-back, once for the props).

## Dashboard home and Customers (WS-79)

GET renders only. `/dashboard` (`nextjs_dashboard`) and `/customers`, `/customers/:link_id` (`nextjs_customers`); this supersedes the "Not ported" note of WS-70 for these two pages. The JSON endpoints of the customers page (`/customers/paged`, `/customers/sales`, charges, emails, missed posts) and every mutation stay in Rails: `CUSTOMERS_OPTIONS` hands `/customers/paged` and `/customers/sales` back, since the single-segment `:link_id` pattern would otherwise match them.

**Dashboard home** (`server/page-props/dashboard-home/`). `DashboardController#index` runs as filters (`signedInFilters`), in Rails' order: `check_payment_details`, `authorize :dashboard`, `session.delete(:social_connect_return)`, the redirect of a seller suspended for a terms violation, `LargeSeller.create_if_warranted`, the presenter, then `SocialConnectFunnel.record_offers!`. `models/social-connect-funnel.ts` writes the `social_connect_offered` Event rows (`once`, skipped while impersonating); its statements are pinned by `__fixtures__/social-connect-funnel.golden.json` (`scripts/golden/social-connect-funnel.rb`). The presenter reuses `overviewStats` (`user-balance-stats.ts`), `CreatorAnalyticsSales#byProductAndDate`, `followerEventSources` and `taxCenterEnabled`. Outside the US every year is ineligible for a 1099 (`from_us?`), so `tax_forms` is `{}`; a US seller gets `[]` and the `user_tax_forms` notice.

- `LargeSeller.create_if_warranted` (WS-84's `createLargeSellerIfWarranted`) runs in the filter's `action`, as in Rails. Handed to Rails: a seller whose balance stats are cached (`balanceStatsCacheApplies`, shared with Payouts), a best-seller card whose product has an alive thumbnail (Active Storage URL), a seller with a Stripe Connect or PayPal payout account (`has_payout_information?`), and a requested Stripe compliance request carrying a `verification_error` (the message table is `UserComplianceInfoRequest#verification_error_message`).
- Parity: `spec/requests/dashboard_home_signed_in_spec.rb` (19 examples), replayed by `parity/__tests__/dashboard-home.replay.test.ts` (`purchases`, `confirmed_follower_events` and `product_page_views` are rebuilt under `ES_INDEX_SUFFIX`). The Event rows' timestamps are ignored: the first request compiles the route.

**Customers** (`server/page-props/customers/`). `CustomersController#index`: `fetch_sales` over the ported `PurchaseSearchService` (the page offset is `params[:page].to_i` clamped to 499 pages, so `?page=2` skips 40 rows: Rails' behaviour), `CustomersPresenter` and `CustomerPresenter#customer`. `create_user_event("customers_view")` reuses `audience/events.ts`. An unknown `link_id` lists every customer (`Link.fetch` returns nil).

- Ported readings: price (`displayed_price_cents`, `displayed_price_cents_before_offer_code` with a plain offer code, deleted ones included), `amount_refundable_cents_in_currency` (USD), `ppp_info` (the `factor` column is an integer in `schema.rb`: kept as read), `display_referrer`, licenses (the manage token carries a random IV, so the replay ignores it and decrypts it), reviews with the seller's response, tips, calls, custom text fields, `download_count`, access revocation, and the filter box (variants, archived products that sold).
- Handed to Rails when any customer on the page is a member or installment plan, a preorder, a gift, a bundle, a commission, has an affiliate, a refund row, a cached offer code discount, an upsell, a UTM link, a chosen variant or SKU, a physical product, a price in another currency, a review video, a custom field file, or a transaction URL for the seller (a sale not charged through Gumroad's own Stripe account); and when the seller has ping endpoints (`can_ping`).
- Parity: `spec/requests/customers_signed_in_spec.rb`, replayed by `parity/__tests__/customers.replay.test.ts`; the examples named `leaves-a-...` check that the request reaches Rails.
- Agents sharing one Elasticsearch record with `ES_TEST_INDEX_PREFIX=ws79-` (`spec/support/elasticsearch.rb`) and replay with `PARITY_RAILS_INDEX_PREFIX=ws79-` (`parity/src/elasticsearch.ts`).

## WS-12a products and bundles

JSON actions of the products dashboard, served from Node behind `nextjs_products_writes`: `POST /products/archived`, `DELETE /products/archived/:id`, `POST /links/:id/unpublish`, `DELETE /links/:id` (`server/controllers/products-mutations.ts`).

- **JSON mutations.** `registerMutations` takes `json: true` for a `render json:` action: it accepts only a request that asks for JSON (the dashboard's `request()` sends `Accept: application/json, text/html`) and hands any other format to Rails, as the HTML actions do with JSON. Inside, `RequireAccountEmail` answers 403 `{ success, error_message }` and a Pundit refusal 401 `{ success, error }` (both `rescued`: no XSRF-TOKEN), and `RoutingError` becomes the JSON 404.
- **`Link` model.** `Links.save` now also ports `purchase_disabled_at`, `deleted_at` and the `archived` bit of `flags` (any other flag still throws `NotPortedError`), their search-index fields (`ATTRIBUTE_TO_SEARCH_FIELDS_MAP`) and the `submit_to_indexnow` after-commit (`SubmitToIndexnowJob`, which still runs in Ruby).
- **Delete.** `Link#delete!` is `mark_deleted!` plus five delayed jobs (`CancelSubscriptionsForProductWorker` only with an active subscription). Handed back before the first write: a product in a profile section (featured, or in `shown_products`: `clear_featured_product_sections!` / `remove_from_profile_sections!`), a custom domain, public files.
- **Unpublish and collaborators.** `fetch_product_and_enforce_access` lets a collaborator act on another seller's product; the port hands that back (`NotPortedError`) and answers 404 when the user is not a collaborator.
- **Parity.** `spec/requests/products_mutations_signed_in_spec.rb` (18 recorded requests: success, 404, refused roles, already archived, a tiered membership, a membership with subscriptions, the profile-section hand-back), replayed by `parity/__tests__/products-mutations.replay.test.ts`: status, JSON body, cookies, every row written and every job (BullMQ jobs, and Ruby-runtime jobs read from Sidekiq's `queue:*` and `schedule`). The model golden (`link-writes.rb`) was not extended: the generator only runs against a database named `*_wsNN`.
- **Not ported (still Rails):** `LinksController#create/update/publish/index/search/card/price_check/release_preorder/update_sections/disable_downloads_for_all_files/send_sample_price_change_email`, product duplicates, thumbnails, asset previews, the bundle editor and its tabs, product files utilities, `products/*` sub-resources (variants, builds, marketing actions, waitlist, remaining call availabilities, refund policies, offer codes), tags, purchase custom fields, `increment_views`/`track_user_action`, and the WS-77/WS-80 page hand-backs. `publish!` needs content moderation, plan gates, merchant account checks and video transcoding; `update` carries the whole editor payload (variants, tiers, prices, files, rich content, covers, shipping, integrations).
## WS-10a settings and account

`PUT`/`PATCH /settings/third_party_analytics` (flag `nextjs_settings_third_party_analytics_writes`) and `PUT`/`PATCH /settings/advanced` (flag `nextjs_settings_advanced_writes`), in `server/controllers/settings-mutations.ts` over the new `models/third-party-analytic.ts` and `models/blocked-customer-object.ts` (and `clearProductsCache` in `models/user.ts`).

- **Handed to Rails before the first write:** a missing or non-hash `user` param, non-string values for string attributes, and a non-blank `domain` on the advanced page (`CustomDomain#verify` resolves DNS). Clearing the domain (`domain: ""`) is ported.
- **Model runtime fix:** a nil `Json` column is written as SQL NULL (`Prisma.DbNull`), as ActiveRecord does; Prisma would store the JSON literal `null` (seen on the `seller_profiles` insert of a team member's first save).
- **Parity:** `spec/requests/settings_mutations_signed_in_spec.rb` (20 recorded requests: success, validation errors, duplicate blocks, PATCH, admin allowed, marketing/support refused, domain hand-back) replayed by `parity/__tests__/settings-mutations.replay.test.ts`. The replay reads Ruby-owned jobs from Sidekiq's lists and collapses `until_executed` repeats (`InvalidateProductCacheWorker`) and ignores `GenerateSubscribePreviewJob`, whose lock the Rails factories took before the request.
- **Not ported (still Rails):** the other mutations of the settings controllers, the JSON endpoints (`dismiss_ai_product_generation_promo`, `user/invalidate_active_sessions`: the mutation layer hands back non-HTML formats), password, team members/invitations, 2FA, login/signup POSTs and OAuth callbacks.

## WS-10b OAuth and integrations

Flags: `nextjs_social_callbacks`, `nextjs_connections_unlink`, `nextjs_oauth_applications`. Parity: `spec/requests/{social_callbacks_parity,connections_signed_in,oauth_applications_signed_in}_spec.rb` (50 examples) replayed by `parity/__tests__/oauth-integrations.replay.test.ts` against `next dev`; the examples whose name has `-hands-` (or `not-an-object`) must reach the stand-in Rails.

- **Mutation options.** `MutationSpec.skipForgeryProtection` (a controller with `skip_before_action :verify_authenticity_token`: no CSRF or format check) and `formats: ["json"]` (an action that answers JSON; the Pundit 401/403 JSON lives in `controllers/seller-json-guard.ts`). `MutationInput.rawBody` is `request.raw_post`.
- **Webhooks** (`controllers/social-callbacks.ts`): `POST /instagram/deauthorize`, `/instagram/data_deletion`, `GET /instagram/data_deletion/:confirmation_code`, `POST /tiktok/deauthorize`. `services/instagram-signed-request.ts` and `tiktok-webhook.ts` port the HMAC checks (strict base64 like `Base64.urlsafe_decode64`; Instagram user ids exceed 2^53, so the id is read from the JSON source text). A payload that is not an object, a user id that is not a scalar, a TikTok `user_openid` that is not a string, comments in the JSON and a body that is not valid UTF-8 hand back to Rails.
- **Connections**: `POST /settings/connections/unlink_{youtube,instagram,tiktok}`. `unlink_twitter` stays in Rails: it saves the whole `User`.
- **OAuth applications** (`controllers/oauth-applications-mutations.ts`, `models/oauth-application-writes.ts`): create, update, destroy, `POST /settings/applications/:id/access_tokens` (`get_or_generate_access_token`: application lock, grant, token), `DELETE /oauth/authorized_applications/:id` (`revoke_access_for`), and the redirect GETs. Tokens, uids and secrets are `SecureRandom.urlsafe_base64(32)` (Doorkeeper 5.7.1's `default_generator_method`); the shape is pinned by `oauth-application-writes.test.ts`. Hand-backs: an icon (`signed_blob_id`), a blank name or redirect URI, and any redirect URI that is not a plain `http(s)://host[:port][/path]` (Doorkeeper's `RedirectUriValidator` and its messages are not ported). The lock is taken inside one transaction and a lock wait timeout is not retried (Rails retries three times).

### Not covered in WS-10b

Token endpoints (`/oauth/token`, `/revoke`, `/introspect`, `/oauth/token/info`, the device flow, the MCP/Claude/ChatGPT/Muse/IFTTT/Notion aliases): refresh locks, PKCE, dynamic clients and `MobileAccountToken`. Authorization screens (`/oauth/authorize*`, `mobile_pre_authorization`, `/notion/oauth2/authorize`): consent rendering with `PreAuthorization`. Integrations (`circle`, `zoom`, `google_calendar`, `discord`): they call providers through `Ratelimit` (Redis) and Discordrb, and the `oauth_redirect` actions render the unported ERB `application` layout. `mcp_connectors`, `third_party_analytics` and `oauth_completions/stripe` (Stripe call) render ERB or call Stripe. `unlink_twitter` as above. All of these stay in Rails (no entry in `routes.json`).
## Audience, wishlist and event JSON endpoints (WS-13)

Served by Node, each behind its own flag: `POST /events/track_user_action` (`nextjs_events`), `GET /dashboard/{customers_count,total_revenue,active_members_count,monthly_recurring_revenue}` and
`POST /dashboard/dismiss_getting_started_checklist` (`nextjs_dashboard_json`), `POST /wishlists` and `PUT|PATCH|DELETE /wishlists/:id` (`nextjs_wishlists_writes`), `GET /customers/paged`
(`nextjs_customers_paged`, listed ahead of `/customers/:link_id`).

- **JSON actions.** `controllers/json-seller.ts` (`sellerJsonAction`) is Sellers::BaseController for a JSON request: RequireAccountEmail (403 JSON), the policy (401 JSON, `PunditAuthorization`) and a hand-back for any other format.
  `MutationSpec.formats` (`html` default, `json`, `any`) lets a mutation declare the formats it answers itself; the others still go to Rails before the first write. `ActionContext.peekState` reads the session
  and guid for the Events concern without consuming the flash.
- **Events.** `createUserEvent` takes the body params of `EventsController#create`. Event names outside `Event::PERMITTED_NAMES` are dropped for a visitor with no account (still `{success: true}`); `signup` (a `SignupEvent`) and
  non-string params are handed back. The recorder sends an explicit User-Agent: the replay's HTTP client would otherwise add its own to `browser` and `browser_fingerprint`.
- **Wishlists.** Rails' ParamsWrapper wraps a JSON body without a `wishlist` key under it, limited to the table's columns; the port does the same. A missing or empty `wishlist` goes to Rails (ParameterMissing).
- **Customers paged.** Only `page`, `query`, `sort[key|direction]` and `bought_from` are served; any filter parameter (products, variants, amounts, dates, country, license uses, active customers) goes to Rails whole.
- Parity: `spec/requests/{dashboard_json,wishlists_mutations,customers_paged}_signed_in_spec.rb`, replayed by `parity/__tests__/{dashboard-json,wishlists-mutations,customers-paged}.replay.test.ts` (21, 15 and 11 recorded
  requests). Seed the recording DB with `rails db:seed` (the Gumroad merchant accounts) and replay against a second, schema-only database, since the replay truncates its own.

Not ported from the WS-13 list, and why: followers (`create`, `from_embed_form`, `confirm`, `cancel`, `destroy`, `new`: the `Follower` model, its confirmation mail, CAPTCHA and cutover callbacks are not in `models/`), wishlist products and followers,
UTM link CRUD and `GET /u/:permalink` (Addressable query re-encoding), piracy report mutations, `ConsumptionEvent` (`POST /consumption_analytics`), test pings (outbound HTTP), the other customers JSON endpoints (charges, emails,
missed posts, product purchases), `/customers/import*`, `GET /customers/sales` (no such action in Rails), `PATCH /workflows/:id/emails`, the emails preview/send actions, `POST /audience/export`, `/dashboard/download_tax_form`, the Discover
autocomplete DELETE and `/discover/categories`, `GET /recommended_products` and `GET /seller_plan/checkout`.

## Reviews, customers' actions, affiliate redirect (WS-12b)

JSON fetches of the seller dashboard and the affiliate link, served by Node. Flags: `nextjs_affiliate_redirect`, `nextjs_customer_actions`, `nextjs_review_responses`, `nextjs_imported_customers`. Parity: `spec/requests/{affiliate_redirect_parity,seller_json_mutations_signed_in,product_review_responses_signed_in,shipments_signed_in,imported_customers_signed_in}_spec.rb` (60 recorded exchanges), replayed by `parity/__tests__/ws12b.replay.test.ts` (a stand-in for Rails receives every hand-back; `hands-a-...` fixtures assert it).

| Route | Rails | Notes |
| --- | --- | --- |
| `GET /a/:affiliate_id[/:unique_permalink]` | `AffiliateRedirectController#set_cookie_and_redirect` | `controllers/affiliate-redirect.ts`. The cookie rides `Redirected.cookies`. The merged query is written the way Addressable writes it (sorted, `+` is a space, `%20`); a destination Addressable might reject, an empty pair, a non-UTF-8 component, a `.format` suffix, a collaborator and an id beyond 30 bits go to Rails. The cookie value is the second it was set: the replay checks it is near now instead of comparing it. |
| `PUT/PATCH /calls/:id`, `PUT/PATCH /licenses/:id` | `CallsController#update`, `LicensesController#update` | `controllers/customer-actions.ts`, models `call.ts`, `license.ts`. |
| `PUT/PATCH/DELETE /product_review_responses/:id` | `ProductReviewResponsesController` | The first reply of a review (it emails the reviewer) and a review on a subscription or gift purchase go to Rails. |
| `POST /shipments/:purchase_id/mark_as_shipped` | `ShipmentsController#mark_as_shipped` | Only for an order that already has its shipment (a new one validates against the product as it was at checkout, through PaperTrail). The `order_shipped` mail job is pushed through `deliverLater`; the Rails recorder does not see ActiveJob's test adapter, so the replay asserts it in Sidekiq's `low` queue instead. |
| `GET /imported_customers`, `DELETE /imported_customers/:id` | `ImportedCustomersController` | `timeAgoInWords` is pinned to ActionView (`time-ago-in-words.golden.json`). A removal of a customer that does not exist raises `Pundit::NotDefinedError` in Rails (a 500): handed back. |

- **JSON mutations.** `MutationSpec.json: true` (`controllers/mutation.ts`) lets an action answer a `fetch` with `Accept: application/json`; the other format is handed back as before. `controllers/seller-json.ts` holds `render json:`, `head :no_content`, `RequireAccountEmail`'s 403 and Pundit's 401 for that format. `Rendered.contentType: ""` writes no `Content-Type` (a `head`).
- **Ruby behaviour kept.** `LicensesController` authorizes against the signed-in seller, not the license's: any seller holding a license's manage token can edit it (a fixture pins it).
- **Not ported (still Rails):** `GET /offer_codes/compute_discount|selection_discounts` (`OfferCodeDiscountComputingService` with carts, usage limits, buyer history and cross-sells; `ProductProps#selection_discounts`), `GET /imported_customers/unsubscribe/:id` (ERB view), `POST /commissions/:id/complete` (money), `PATCH/PUT /commissions/:id` (Active Storage), `GET /global_affiliates/product_eligibility/:url` (fetches the product's public JSON through SsrfFilter), `/product_reviews*` and `/product_review_videos*` (`ProductReviewPresenter`, Pagy, video uploads and streams), collaborators and affiliates CRUD, incoming collaborations, affiliate requests (mailers, workflows, audience-member and search updates).


## Library, communities and upload endpoints (WS-16)

Mutations and JSON endpoints, all recorded from Rails (`spec/requests/{library_mutations,communities_mutations,secure_redirect_mutations}_signed_in_spec.rb`,
`content_delivery_json_signed_in_spec.rb`; 12 + 20 + 12 + 24 requests plus the sign-in and CSRF set-up) and replayed by `parity/__tests__/content-delivery-mutations.replay.test.ts`
(64 tests: status, redirect, flash, cookies, JSON, every row written, every job).

- **Flags**: `nextjs_library_writes`, `nextjs_communities_writes`, `nextjs_auth_secure_redirect` (`POST /secure_url_redirect`), `nextjs_s3_utility`, `nextjs_dropbox_files`, `nextjs_media_locations`.
- **Library** (`controllers/library-mutations.ts`, `models/purchase-library-writes.ts`): archive, unarchive and delete flip one flag of the buyer's purchase. The write carries PaperTrail, the
  Elasticsearch `flags` update and the creator analytics cache job. Validations are not run (`update!` would raise on a record that fails them). `skip: ["check_suspended"]` is a new `ActionOptions` entry.
- **Communities** (`controllers/communities-mutations.ts`, `models/community-chat-writes.ts`): chat message create/update/destroy, the read marker (`LastReadCommunityChatMessage.set!`), notification settings.
  The chat broadcast is `infra/anycable.ts`: an `XADD` to AnyCable's `redisx` stream, byte-for-byte what the real gems write (`scripts/golden/anycable.rb`, `infra/__fixtures__/anycable.golden.json`).
  AnyCable's Redis is `ANYCABLE_REDIS_URL`, else `REDIS_URL` (the stream `ANYCABLE_REDIS_CHANNEL` or `__anycable__`); a deployment with neither hands the request back before the first write.
  A message body that is not a hash, or an invalid recap frequency, is Rails' 400/500 and goes to Rails.
- **Secure redirect** (`controllers/secure-redirect-mutations.ts`, `auth/secure-encrypt.ts`): `SecureEncryptService.decrypt` and the confirmation form. A `send_confirmation_text` destination whose query Ruby's `URI`/`Rack` parse would read differently goes to Rails.
- **JSON endpoints** (`controllers/json-actions.ts`): `jsonAction` runs a route handler through `processAction`; `jsonSellerGuard` answers Pundit's refusal as `401 {success: false, error}` for JSON (`MutationSpec.anyFormat` lets a mutation take JSON).
  S3 utility (`generate_multipart_signature`, `current_utc_time_string`, `cdn_url_for_blob`), Dropbox chooser (`index`, `create`, `cancel_upload`; the S3 transfer stays `TransferDropboxFileToS3Worker` in Sidekiq) and `POST /media_locations`.
  Hand-backs: a Dropbox `link_id` that is not the seller's product (Rails leaves the file row behind), an EPUB location with a CFI, a `consumed_at` that is not ISO 8601 with an offset, a blob on another storage service.
- **Not served by Node** (still Rails, not in `routes.json`): every `UrlRedirects` route (`/d`, `/r`, `/s`, `/read`, `/zip`, `/media_urls`, `confirm`, `change_purchaser`, `send_to_kindle`, `save_last_content_page`, `play`), `GET /read` and `/library` on custom hosts,
  the Active Storage engine routes (`/rails/active_storage/**`: its controllers inherit `ActionController::Base`, not `ApplicationController`, so they need their own chain; the signed-id verifier and the SigV4 PUT presign for direct uploads need goldens),
  PDF/EPUB stamping, and `Purchases/Invoices/New`. The signing building blocks they need already exist (`infra/signed-urls.ts`: CloudFront and S3 presigned downloads, `infra/storage.ts`).


## Public files, lookup data and the account switcher (WS-11)

Routes that are not pages (no props, no Inertia envelope) carry a `handler` in `routes.json`; the proxy rewrites them to `/gr-public/<handler>` (`app/gr-public/[action]/route.ts` -> `server/controllers/public-handlers.ts`), which runs them through `processAction` so the session, guid, `XSRF-TOKEN`, SecureHeaders and Rack::Cors are Rails'. A route key may now constrain a parameter and carry a suffix (`"/:key([a-zA-Z0-9-]{8,128}).txt"`, Rails' `constraints: { key: /.../ }`).

| Route (flag) | Rails | Notes |
| --- | --- | --- |
| `/robots.txt` (`nextjs_robots`, any host) | `RobotsController#index` | `bare` (no session, guid or XSRF-TOKEN, as `session_options[:skip]`); sitemaps from the `robots_redis_namespace:sitemap_configs` cache, a miss (the S3 listing) is Rails'. |
| `/llms.txt` (`nextjs_llms`), `/crossdomain.xml` (`nextjs_crossdomain`) | `LlmsController#index`, `PublicController#crossdomain` | `llms` is `app/views/llms/index.erb` read as it is (no ERB tags); `/crossdomain` without `.xml` is a 406 in Rails and stays there. |
| `/favicon.ico` (`nextjs_favicon`, any host) | `FaviconsController#show` | Seller/product host: 302 to `avatar_url`; otherwise `public/favicon.ico` (the binary body goes through `Rendered.body: Uint8Array`). |
| `/:key.txt` (`nextjs_indexnow_key`, any host) | `IndexnowKeysController#show` | `GlobalConfig.get("INDEXNOW_KEY")`, constant-time compare. |
| `seller:` and `product:/.well-known/acme-challenge/:token` (`nextjs_acme_challenge`) | `AcmeChallengesController#show` | Redis `acme_challenge:<token>`. |
| `/github_stars` (`nextjs_github_stars`) | `GithubStarsController#show` | Serves the `Rails.cache` entry; a miss (the GitHub API call) is Rails'. |
| `/charge_data`, `/license_key_lookup_data`, `/paypal_charge_data` (`nextjs_public_lookup_data`) | `PublicController` | `server/controllers/public-data.ts`. `CustomerMailer.grouped_receipt` is enqueued as Rails' MailDeliveryJob (it stays a Ruby mailer), `SendPurchaseReceiptJob` through the registry. Array-shaped params and a valueless `invoice_id` are Rails'. |
| `/js/gumroad-analytics` (`nextjs_embedded_analytics_js`, any host) | `EmbeddedJavascriptsController#analytics` | Verifies the script token with `railsMessageVerifierVerified` and mints the ten-minute view token (`exp` in the message metadata). Only for `Accept: */*` or a JavaScript type: an HTML request is a MissingTemplate 500 in Rails and goes there. |
| `POST /working-webhook` (`nextjs_public_working_webhook`) | `PublicController#working_webhook` | Mutation. |
| `POST /sellers/switch` (`nextjs_sellers_switch`, `signedInOnly`) | `Sellers::SwitchController#create` | Mutation: stamps `team_memberships.last_accessed_at` (`models/team-membership.ts`, PaperTrail only; its validations are not ported) and writes the `current_seller_id` cookie through the new `Rendered.cookies`. |

- **`processAction` additions.** `ActionOptions.bare`, `ActionOptions.xsrfCookieBytes`, `Rendered.cookies`, an empty `Rendered.contentType` for `head :no_content`, and ETags for a response that sets its own `Cache-Control` (Rack::ETag skips only `no-cache`).
- **Rails bug kept.** `AcmeChallengesController#mask_token` shadows `ActionController::RequestForgeryProtection#mask_token`, so the `XSRF-TOKEN` cookie of an ACME response is the first two and last two bytes of the global CSRF token around `...`, not a masked token. The port writes the same bytes; the recorder keeps such a value escaped (it is not UTF-8).
- **Parity.** `spec/requests/{public_files,public_data,sellers_switch}_parity_spec.rb` (24 + 15 + 4 examples) replayed by `parity/__tests__/ws11-public.replay.test.ts` (43 cases, `github_stars` aside: the request spec fills `Rails.cache` in the Rails process only). Record the files with `SECRET_KEY_BASE=parity-replay-secret-key-base` so the replay can verify the script token and read the `current_seller_id` cookie. A request spec's ActiveJob adapter is the test one, so the mail jobs are not in the fixtures: the replay reads them back from Redis and asserts the `grouped_receipt` arguments. Purchases are inserted with `save!(validate: false)`: the factory charges a card.
- **Not ported from the WS-11 list** (still Rails): `GET /js/gumroad`, `/js/gumroad-overlay`, `/js/gumroad-multioverlay`, `/js/gumroad-embed` (they render Vite manifest URLs), the `home#*` pages and `/gumclaw` (ERB pages in the `home` layout), `POST /custom_domain/verify` (DNS lookups), `GET /blog/p`, `POST /help/contact`, `POST /sellers/brand_accounts`, comments, profile sections and seller pages CRUD, `POST /posts/:id/increment_post_views`, `send_for_purchase`, the `users#*` storefront actions (`coffee`, follow/unfollow, subscribe, `show`/`edit`, landing pages, unsubscribe and review reminder links, `current_user_data`, `session_info`, `deactivate`, `add_purchase_to_library`) and the profile hand-backs (featured product, wishlists, signed-in visitors).


## WS-17f mobile API

The mobile apps' endpoints on the API host (`Api::Mobile::*Controller`, `/mobile/...` under `ApiDomainConstraint`). 16 of the 63 uncovered routes are served by Node, each behind its own flag (`nextjs_mobile_{feature_flags,devices,calls,licenses,review_videos,media_locations,consumption_analytics,accounts,analytics}`).

- **Routing.** A route entry carries `"hosts": "api"` (`HostScope`, matched by `classifyHost(...).api`, so every host in development) and `"handler": "mobile"`; the key may carry the method (`"POST /mobile/devices"`). The proxy rewrites it to `/gr-public/mobile`, which now exports every method and lands in `controllers/mobile-api.ts`. Actions register with `registerMobile({ method, pattern, scopes, run })` (`controllers/mobile-{simple,accounts,analytics}.ts`, imported by the route file).
- **Chain.** `mobileResponse` runs `processAction` (ApplicationController's filters and the response envelope), then `Api::Mobile::BaseController#check_mobile_token` (`MOBILE_TOKEN`, constant-time; 401 JSON, a halt without the XSRF-TOKEN cookie), then `doorkeeper_authorize!` with the action's scopes (`auth/api-token.ts`: `head 401` with `WWW-Authenticate` or `head 403`), then the action with `MobileAuth` (`apiUser`, `owner` = `current_resource_owner`, `accountHolder` = the team member behind a brand token, `impersonated`).
- **Null session.** A write without a CSRF token runs under `protect_from_forgery`'s null session: nothing is read from or written to cookies, so the response carries no `Set-Cookie` at all. The port runs writes with `ActionOptions.bare` and hands a write that carries any `Cookie` header to Rails (it would have to judge the token). A GET keeps the full envelope (session, guid and XSRF-TOKEN cookies, domain `gumroad.com`).
- **Hand-backs** (`HandBackToRails` / `NotPortedError` before the first write; fixtures `mobile_hand_backs_parity_spec`): a write with cookies, a switch to a brand account (`Ai::StoreAgentScopes`), a `consumed_at` that is not ISO 8601 with an offset, a `folder_download` event, `auto_marketing` flag checks (`Marketing::Eligibility`), a call or video that no longer validates, a date range that is not `YYYY-MM-DD`, a non-scalar parameter where Rails casts or permits.
- **Models added**: `Device` (`models/device.ts`), `ProductReviewVideo` approval (`models/product-review-video.ts`), `ConsumptionEvent.create_event!` (`models/consumption-event.ts`). `recordMediaLocation` is shared with `POST /media_locations`; `Calls`, `Licenses` and the analytics services are the ones the web pages use. Analytics adds the `group_by` day/month grouping (`ByDate#group_*_data_by_*`) and the revenue totals aggregation.
- **Parity.** `spec/requests/api/mobile/mobile_{api,accounts,analytics,hand_backs}_parity_spec.rb` (32 + 15 + 17 + 4 examples) replayed by `parity/__tests__/mobile-api.replay.test.ts` (52: status, headers, cookies, JSON, every row, every job) and `mobile-analytics.replay.test.ts` (19, with the clock frozen at `PARITY_NOW` and the purchases index rebuilt from the seeded rows). The spec helpers are in `spec/support/parity/mobile_api.rb`: the purchase factories charge a card, so a purchase row is built and saved with `validate: false`. Doorkeeper mints account-switch tokens at random, so the replay ignores them.
- **Elasticsearch on a full disk.** The cluster puts indices on `read-only-allow-delete` past the flood-stage watermark; recording the analytics spec needed `cluster.routing.allocation.disk.threshold_enabled=false` (transient) on the local node.

Not served by Node (still Rails, not in `routes.json`): `purchases` (`index`, `search`, `purchase_attributes`, `archive`, `unarchive`, `destroy`: `Purchase#json_data_for_mobile` and `UrlRedirect#product_json_data`), `url_redirects` (the same serializer, signed CloudFront URLs, HLS playlists, rental state and consumption events), `subscriptions#subscription_attributes` and `#cancel` (`Subscription#cancel!` mails and webhooks are not ported), `preorders#preorder_attributes`, all of `sales` (the controller serializes purchases with `json_data_for_mobile(include_sale_details:)`; `refund` is phase 2), `commissions#complete` (money), `installments#show`, `analytics#data_by_date` (`Purchase#as_json(creator_app_api:)`) and `#products` (`Link#as_json(original: true)`), `products#index` and `#destroy` (`DashboardProductsPagePresenter`, `Link#delete!` and the `delete_product_mobile_app` event row), `sessions#create` (Devise `sign_in` bookkeeping and the session cookie) and `#resend_confirmation_email` (a confirmation mail), and the `agent` endpoints (Anthropic calls, streaming).

## WS-17a API v2 product resources

The first v2 API routes in Node: the product's resources under `/v2/...` (API host) and `/api/v2/...` (Gumroad domain).

- **Mechanism.** `routes.json` lists both forms of a route with `"handler": "api-v2"` and the flag `nextjs_api_v2_products` (`"api:/v2/..."` is the API host, the new `api` host scope of the route table, `ApiDomainConstraint`; keys carry the method for writes). The proxy rewrites them to `/gr-public/api-v2` (`gr-public/[action]/route.ts` now answers every method), which lands in `controllers/api-v2/base.ts`: `registerApiV2({ method, pattern, scopes, before, run })` is `Api::V2::BaseController` (the ApplicationController chain through `processAction`, `doorkeeper_authorize!` with the implicit `account` scope and the deleted-owner check from `auth/api-token.ts`, `fetch_product`, `render_response`/`error_with_object`, the `log_method_use` after_action that marks CLI users). A request no registered route matches (a sibling of `/v2/products/:id`, such as `/v2/products/comps`) is forwarded to Rails whole. `api-v2/routes.test.ts` keeps `routes.json` and the registry in step.
- **Null session.** `protect_from_forgery` answers an unverified POST, PUT, PATCH or DELETE with a null session and cookie jar: no session, `_gumroad_guid` or `XSRF-TOKEN` cookie. Writes therefore run with `ActionOptions.bare`; a write that carries `X-CSRF-Token`, `X-XSRF-Token` or `authenticity_token` (which might verify) goes to Rails. `render json:` answers `Vary: Accept` to a client whose `Accept` is not browser-like even though the action read `params`, so the API's JSON responses do not set `paramsRead`.
- **Served** (both hosts): `GET /v2/categories`, `GET /v2/refund_policy`, `GET /v2/products/:link_id/{skus,custom_fields,variant_categories,variant_categories/:id,builds,builds/:id}`, `GET .../variant_categories/:variant_category_id/variants[/:id]`, `GET /v2/products/:id/custom_html`; `POST/PUT/PATCH/DELETE` of `custom_fields`, `POST/PUT/PATCH` of `variant_categories`. `api-v2/records.ts` holds the `as_json` of VariantCategory, Variant (with `recurrence_price_values(for_edit: true)`), Sku, CustomField and ProductBuild, `product-resources.ts` the reads, `product-resource-writes.ts` the writes. Variant rich content hides behind `has_same_rich_content_for_all_variants` and `recoverable_hidden_variant_rich_content?`; when that needs `RichContent#has_editor_content?` on a page with a body but no title (a walk of the node tree) the request goes to Rails.
- **Hands back before its first write** (`NotPortedError`): a custom-field or variant-category parameter that is not a string.
- **Not ported (still Rails)**, with the reason:
  - `GET/POST/PUT/PATCH/DELETE /v2/products[...]` (`LinksController`: index, show, create, update, destroy, enable, disable, sections, preview/edit custom HTML, comps): they all answer with `Product::AsJson#as_json_for_api`, which needs files with signed S3 URLs, covers and thumbnails through Active Storage, PPP prices, `Api::ProductSectionsPresenter` and cached sales stats, none of which is ported; create/update also run `SaveFilesService`, `SaveContentUpsellsService` and the rich-content pipeline. Product creation, `PUT/PATCH /v2/products/:id`, `comps`, `preview_custom_html` and `POST /v2/media` are throttled by Rack::Attack (`config/initializers/rack_attack.rb`), which Node does not run.
  - `DELETE` of a variant category and of a variant: both write a `ProductVariantDeletionAudit` row after commit (and the variant delete runs `update_attribute(:deleted_at)` with a row lock).
  - `POST`, `PUT`, `PATCH`, `DELETE` of variants (`price_must_be_within_range`, `set_customizable_price`, `sync_product_customizable_price`, the search-index update and the rich-content save), `PUT /v2/refund_policy` (the paper-trail version and the AI fine-print classifier), `PUT /v2/products/:link_id/bundle_contents` (`Bundle::UpdateProductsService`), thumbnails and covers (Active Storage attach and analyze), `POST /v2/products/:link_id/builds/deploy` and `promote` (S3 copy, product files), `GET/POST/DELETE /v2/media` (`PublicFilePresenter`, `CreatePublicMediaService`), `POST /v2/files/{presign,complete,abort}` and `POST /v2/direct_uploads` (S3 multipart and presigned uploads).
- **Parity.** `spec/requests/api/v2/products_api_{categories,reads,resource_writes}_parity_spec.rb` (4 + 37 + 20 examples; request specs, because a controller spec records no query string, so no `access_token`), helpers in `spec/support/parity/api_v2_requests.rb`, replayed against `next dev` by `parity/__tests__/api-v2-products.replay.test.ts` (63 cases, 2 of them hand-backs that must reach the stand-in Rails with their body and write nothing).


## WS-17b API v2 sales, licenses and offer codes

WS-17b registers its controllers with WS-17a's dispatcher (`server/controllers/api-v2/base.ts`: `registerApiV2`, handler `api-v2`, `api:` host scope), one file per controller under `server/controllers/api-v2/`, with one Flipper flag per controller (`nextjs_api_v2_*`). `api-v2/pagination.ts` is `Api::V2::BaseController`'s keyset pagination (`encodePageKey` / `decodePageKey` / `next_page_url`; the time is read with `DATE_FORMAT(..., '%f')` because Prisma's `Date` drops microseconds). A path with a `.json` suffix matches no route key, so it stays with Rails.

| Route (flag) | Rails | Notes |
| --- | --- | --- |
| `GET products/:link_id/reviews` (`nextjs_api_v2_product_reviews`) | `ProductReviewsController#index` | Keyset page of `visible_on_product_page` reviews. The `LEFT JOIN` on the approved video is kept as Rails writes it (a review with two approved videos appears twice). |
| `GET offer_codes`, `offer_codes/:id`, `products/:link_id/offer_codes`, `products/:link_id/offer_codes/:id` (`nextjs_api_v2_offer_codes`) | `OfferCodesController#index`, `#show` | `times_used` through `OfferCodeRecord#timesUsed`. |
| `GET upsells`, `upsells/:id` (`nextjs_api_v2_upsells`) | `UpsellsController#index`, `#show` | `discount` is `OfferCode#configured_discount_for_display` (product ids, exclusions, option ids, tiers). |
| `GET resource_subscriptions`, `DELETE resource_subscriptions/:id` (`nextjs_api_v2_resource_subscriptions`) | `ResourceSubscriptionsController#index`, `#destroy` | `mark_deleted!` is one `UPDATE` (the model has no other callback or PaperTrail). |
| `GET earnings`, `GET tax_forms` (`nextjs_api_v2_tax`) | `EarningsController#show`, `TaxFormsController#index` | `Api::V2::TaxCenterAccess`; the totals are the Tax Center page's `totals`. `Integer(params[:year])` with a radix prefix (`0x7e9`) is Rails'. |
| `POST sales/:id/resend_receipt` (`nextjs_api_v2_sales`) | `SalesController#resend_receipt` | Enqueues `SendPurchaseReceiptJob(id, true)`; a preorder authorization or a gift sender (a second receipt, or a mailer) is handed back. |

- **Parity.** `PARITY_RECORD=all bin/rspec spec/controllers/api/v2/<controller>_spec.rb` records the controller specs (fixtures in `parity/fixtures/controllers/api/v2`); `parity/__tests__/api-v2-ws17b.replay.test.ts` replays 83 exchanges against `next dev` (83 replayed, 4 skipped with the reason in the test title). The recorder (`spec/support/parity/recorder.rb`) now keeps a controller spec's params as the query or form body and derives the path from the route (`generate_extras`): the test request keeps neither after it returns, and a later request of the same example reused the previous path. The replay sends the `/api/v2/...` form of the path without the `.json` suffix; `api-v2/routes.test.ts` checks routes.json against the registry. A `page_key` is rebuilt from the seeded row it names, because the seed is relative to the replay's clock. Controller specs run no Rack middleware, so cookies and the Rack-added headers are not compared (the envelope is `processAction`'s, as for every route).
- **Local recording needs `bin/rails db:seed`** on the scratch database (the Stripe/PayPal/Braintree merchant account rows the purchase factory looks up).
- **Not ported (still Rails), by route.**
  - `Purchase#as_json(version: 2)` (about 90 keys: relative times, formatted prices, PPP, buyer presentment, variants, reviews) is the shared blocker of `sales#index|show|mark_as_shipped|revoke_access|undo_revoke_access`, all five `licenses#*` (`verify`, `enable`, `disable`, `rotate`, `decrement_uses_count` render the purchase's `payload_for_ping_notification` and `as_json_for_license`), `subscribers#index|show` (`Subscription#as_json`: status, recurrence, free-trial) and `sales#summary`.
  - `sales#export` (`Exports::PurchaseExportService`), `sales#refund` (money, phase 2).
  - `offer_codes#create|update|destroy` (OfferCode's validations, cache invalidation and reindex callbacks), `upsells#create|update|destroy` (`SaveUpsellService`).
  - `payouts#index|show|upcoming` (`Payment#as_json`, `Exports::Payouts::Api`, `upcoming_payouts`; phase 2 by the brief).
  - `resource_subscriptions#create` (DNS resolution against SsrfFilter's reserved ranges) and `#test_event` (an HTTP delivery), `tax_forms#download` (Stripe API / S3).
- **Spec notes.** `earnings` and `tax_forms` "404 when the year is before the account-creation year" fail in Ruby itself on a date later than the spec's `travel_to` assumes. The aggregated-earnings and filed-at examples are date-pinned and cannot replay on another day; `totals` is shared with the Tax Center page replay.
