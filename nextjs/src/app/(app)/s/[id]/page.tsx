// UrlRedirectsController#stream (props in server/page-props/url-redirects/player-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import UrlRedirectsStream from "./UrlRedirectsStream";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/s/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsStream />
    </InertiaShell>
  );
}
