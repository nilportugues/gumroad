// UrlRedirectsController#rental_expired_page (props in server/page-props/url-redirects/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UrlRedirectsRentalExpired from "./UrlRedirectsRentalExpired";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/r/:id/rental_expired", { id });

  return (
    <InertiaShell page={page} layout="standalone">
      <UrlRedirectsRentalExpired />
    </InertiaShell>
  );
}
