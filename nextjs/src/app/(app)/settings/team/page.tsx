// Settings::TeamController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsTeam from "./SettingsTeam";

export default async function Page() {
  const page = await renderPage("/settings/team", {});

  return (
    <InertiaShell page={page}>
      <SettingsTeam />
    </InertiaShell>
  );
}
