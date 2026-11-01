// SecureRedirectController#new at /secure_url_redirect (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import SecureRedirectNew from "../_auth/SecureRedirectNew";

export default async function Page() {
  const page = await renderPage("/secure_url_redirect", {});

  return (
    <InertiaShell page={page}>
      <SecureRedirectNew />
    </InertiaShell>
  );
}
