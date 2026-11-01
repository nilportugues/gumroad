// Settings::ThirdPartyAnalyticsController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsThirdPartyAnalytics from "./SettingsThirdPartyAnalytics";

export default async function Page() {
  const page = await renderPage("/settings/third_party_analytics", {});

  return (
    <InertiaShell page={page}>
      <SettingsThirdPartyAnalytics />
    </InertiaShell>
  );
}
