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

- `InertiaRails.scroll` and `<InfiniteScroll>`: the server emits no `scrollProps`, so Communities (the one
  page that uses it) is not convertible yet. `<Form>` throws as well; `useRemember` uses sessionStorage instead of history state.
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
- **What still throws `NotPortedError`**: a GeoIP2 city database on disk (`ip_country_code`); the
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
