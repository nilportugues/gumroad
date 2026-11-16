// UrlRedirectsController#membership_inactive_page (props in server/page-props/url-redirects/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UrlRedirectsMembershipInactive from "./UrlRedirectsMembershipInactive";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/r/:id/membership_inactive", { id });

  return (
    <InertiaShell page={page} layout="standalone">
      <UrlRedirectsMembershipInactive />
    </InertiaShell>
  );
}
