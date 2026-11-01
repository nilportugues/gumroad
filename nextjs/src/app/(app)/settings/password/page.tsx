// Settings::PasswordController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsPassword from "./SettingsPassword";

export default async function Page() {
  const page = await renderPage("/settings/password", {});

  return (
    <InertiaShell page={page}>
      <SettingsPassword />
    </InertiaShell>
  );
}
