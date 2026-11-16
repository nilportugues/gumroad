// UrlRedirectsController#confirm_page (props in server/page-props/url-redirects/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import UrlRedirectsConfirmPage from "./UrlRedirectsConfirmPage";

export default async function Page() {
  const page = await renderPage("/confirm", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsConfirmPage />
    </InertiaShell>
  );
}
