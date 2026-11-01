// Wraps a converted page the way Rails' inertia layout does: the page object in `data-page` (what
// the Inertia client, and the parity replays, read the component name, props, url and version
// from), then the client half that renders the page.
import { railsJson } from "@/server/page-props/inertia-json";
import type { InertiaPage } from "@/server/page-props/load-page";

import { InertiaShellClient, type ShellLayout } from "./InertiaShellClient";

export function InertiaShell({ page, layout, clientOnly, children }: { page: InertiaPage; layout?: ShellLayout; clientOnly?: boolean; children: React.ReactNode }) {
  // `href` is for the shared AppWrapper; it is not part of inertia_rails' page object.
  // Deferred props are fetched by the client's follow-up partial reload, as Inertia 2 does, so the loaders stay unused here.
  const { href: _href, deferredLoaders: _deferredLoaders, ...inertiaPage } = page;
  return (
    <>
      <script type="application/json" data-page="app" dangerouslySetInnerHTML={{ __html: railsJson(inertiaPage) }} />
      <InertiaShellClient page={{ ...inertiaPage, href: page.href }} layout={layout} clientOnly={clientOnly}>
        {children}
      </InertiaShellClient>
    </>
  );
}
