// Settings::SocialConnectionsController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsSocialConnections from "./SettingsSocialConnections";

export default async function Page() {
  const page = await renderPage("/settings/social_connections", {});

  return (
    <InertiaShell page={page}>
      <SettingsSocialConnections />
    </InertiaShell>
  );
}
