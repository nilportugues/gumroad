# Converting an Inertia page to the App Router

The reference conversion is `help/category/[slug]/` (`HelpCenter::CategoriesController#show` →
`HelpCenter/Categories/Show`). Rails keeps serving the original until the route's flag is on, so the
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
- Write `page.tsx` as a server component that calls `loadPage(component, action, { url })`.
  `loadPage` runs the ApplicationController meta tags, then your action, then `inertia_share`, and
  deep-merges like `deep_merge_shared_data`. Inside the action:
  - `meta.set({...})` for every `set_meta_tag` (controller `before_action`s first, in order).
  - `urlOptions` for `*_url` helpers, so hosts match `ApplicationController#default_url_options`.
  - Pass `mobileAppWebView: true` if the controller calls `enable_mobile_app_web_view`, and merge
    controller-level `inertia_share` props yourself (e.g. `settings_pages` for Settings pages).
- `InertiaRails.defer { ... }`: pass the prop as an unawaited promise; `<Deferred>` and `usePage()`
  treat it as undefined until it resolves. `optional`/`merge`/`scroll` props have no equivalent yet
  (see "Not covered").
- Redirects: `redirect()` from `next/navigation` (307, where Rails usually sends 302; note it).

## 3. Copy the page component (client)

1. Copy the file next to `page.tsx` (e.g. `HelpCenterCategory.tsx`) and add `"use client";`.
2. Replace `from "@inertiajs/react"` (and `@inertiajs/core`) with `from "@/lib/navigation"`.
3. Rewrite relative imports to `$app/pages/...` (page-local helpers stay where they are), or
   copy them too if they are only used by this page.
4. Render it inside `<InertiaShell page={page} layout="...">` from `page.tsx`.

Shared components need no change: next.config.ts aliases `@inertiajs/*` to the compat module,
injects the `Routes` global, turns `$assets/...` imports into URL strings and defines `SSR`.

## 4. Route it

1. Add the path to `nextjs/routes.json` with a new Flipper flag, e.g.
   `"/help/category/:slug": { "flag": "nextjs_help_center_category" }`. `:param` excludes `.`
   like Rails, so `.html`/`.json` variants stay with Rails. Set `"hosts"` if the route is not on
   the app domain, and `"signedOutOnly": true` while the signed-in shared props are unported.
2. Add any helper the page graph needs to `src/lib/navigation/routes.ts`; `npx tsc --noEmit`
   lists the missing ones.

## 5. Verify

- `npx tsc --noEmit`, `npx vitest run`, `npx next build`.
- Locally: `NEXTJS_ROUTE_FLAGS=<flag> NEXTJS_ASSUME_SIGNED_OUT=1
  RAILS_ORIGIN=http://localhost:3000 npm run dev` and open the page on port 3100.
- Parity: diff the props against Rails' Inertia JSON for the same request
  (`curl -H 'X-Inertia: true' -H 'X-Inertia-Version: ...'` against Rails), ignoring
  `authenticity_token`/`csrf-token` (masked per call) and `csp_nonce`.

## Not covered yet (convert by hand)

- `InertiaRails.merge`/`scroll` (append-on-paginate) and `optional` props: `router.reload({ only })`
  re-renders every prop, so pages that page through lists by merging need a client fetch or a
  server action instead.
- `<InfiniteScroll>` and `<Form>` throw; `useRemember` uses sessionStorage instead of history state.
- `import.meta.glob` (Vite-only) in a page's import graph fails to build.
- Mutations still go to Rails over the Inertia protocol (`useForm.post` etc.); once an endpoint is
  ported, return a redirect from a route handler or use a server action.
