// Settings::MainController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import SettingsMain from "./SettingsMain";

export default async function Page() {
  const page = await renderPage("/settings", {});

  return (
    <InertiaShell page={page}>
      <SettingsMain />
    </InertiaShell>
  );
}
