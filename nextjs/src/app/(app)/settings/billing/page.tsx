// Settings::BillingController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsBilling from "./SettingsBilling";

export default async function Page() {
  const page = await renderPage("/settings/billing", {});

  return (
    <InertiaShell page={page}>
      <SettingsBilling />
    </InertiaShell>
  );
}
