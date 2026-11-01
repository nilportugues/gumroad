// Settings::ProfileController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import SettingsProfile from "./SettingsProfile";

export default async function Page() {
  const page = await renderPage("/profile", {});

  return (
    <InertiaShell page={page}>
      <SettingsProfile />
    </InertiaShell>
  );
}
