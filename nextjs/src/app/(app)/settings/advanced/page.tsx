// Settings::AdvancedController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsAdvanced from "./SettingsAdvanced";

export default async function Page() {
  const page = await renderPage("/settings/advanced", {});

  return (
    <InertiaShell page={page}>
      <SettingsAdvanced />
    </InertiaShell>
  );
}
