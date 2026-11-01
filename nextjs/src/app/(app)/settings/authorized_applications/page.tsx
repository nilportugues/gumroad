// Settings::AuthorizedApplicationsController#index (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsAuthorizedApplications from "./SettingsAuthorizedApplications";

export default async function Page() {
  const page = await renderPage("/settings/authorized_applications", {});

  return (
    <InertiaShell page={page}>
      <SettingsAuthorizedApplications />
    </InertiaShell>
  );
}
