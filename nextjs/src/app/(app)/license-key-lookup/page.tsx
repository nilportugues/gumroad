// PublicController#license_key_lookup (props in server/page-props/public-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import LicenseKey from "./LicenseKeyLookupPage";

export default async function Page() {
  const page = await renderPage("/license-key-lookup", {});

  return (
    <InertiaShell page={page}>
      <LicenseKey />
    </InertiaShell>
  );
}
