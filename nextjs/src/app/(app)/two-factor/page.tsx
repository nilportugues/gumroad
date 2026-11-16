// TwoFactorAuthenticationController#show at /two-factor (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import TwoFactorAuthenticationShow from "../_auth/TwoFactorAuthenticationShow";

export default async function Page() {
  const page = await renderPage("/two-factor", {});

  return (
    <InertiaShell page={page} layout="public">
      <TwoFactorAuthenticationShow />
    </InertiaShell>
  );
}
