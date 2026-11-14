// UrlRedirectsController#stream for one file (props in server/page-props/url-redirects/player-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UrlRedirectsStream from "../UrlRedirectsStream";

export default async function Page({ params }: { params: Promise<{ id: string; product_file_id: string }> }) {
  const { id, product_file_id: productFileId } = await params;
  const page = await renderPage("/s/:id/:product_file_id", { id, product_file_id: productFileId });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsStream />
    </InertiaShell>
  );
}
