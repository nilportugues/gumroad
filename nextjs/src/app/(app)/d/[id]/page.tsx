// UrlRedirectsController#download_page (props in server/page-props/url-redirects/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import UrlRedirectsDownloadPage from "./UrlRedirectsDownloadPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/d/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsDownloadPage />
    </InertiaShell>
  );
}
