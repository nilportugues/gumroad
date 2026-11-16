// UrlRedirectsController#play (props in server/page-props/url-redirects/play-page.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

import UrlRedirectsPlay from "./UrlRedirectsPlay";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/d/:id/play", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsPlay />
    </InertiaShell>
  );
}
