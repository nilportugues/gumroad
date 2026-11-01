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
   the app domain, `"signedOutOnly": true` while the signed-in shared props are unported, and
   `"inertia": true` for every page registered in `pages.ts` (it turns on the envelope and the
   X-Inertia handling above).
2. Add any helper the page graph needs to `src/lib/navigation/routes.ts`; `npx tsc --noEmit`
   lists the missing ones.

`GET /healthcheck` is deliberately not in the table even though `src/app/healthcheck/route.ts`
ports it: it is the blue/green readiness probe, so it must exercise Rails, and Rails answers it
without touching Redis, which a flagged route would (the proxy reads Flipper on every request).

## 5. Verify

- `npx tsc --noEmit`, `npx vitest run`, `npx next build`.
- Locally: `NEXTJS_ROUTE_FLAGS=<flag> NEXTJS_ASSUME_SIGNED_OUT=1
  RAILS_ORIGIN=http://localhost:3000 npm run dev` and open the page on port 3100.
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
