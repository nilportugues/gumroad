// UrlRedirectsController#expired (props in server/page-props/url-redirects/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UrlRedirectsExpired from "./UrlRedirectsExpired";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/r/:id/expired", { id });

  return (
    <InertiaShell page={page} layout="standalone">
      <UrlRedirectsExpired />
    </InertiaShell>
  );
}
