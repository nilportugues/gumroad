// Settings::PaymentsController#show (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import SettingsPayments from "./SettingsPayments";

export default async function Page() {
  const page = await renderPage("/settings/payments", {});

  return (
    <InertiaShell page={page}>
      <SettingsPayments />
    </InertiaShell>
  );
}
