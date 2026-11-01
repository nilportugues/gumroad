// DashboardController#index (props in server/page-props/dashboard-home/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import DashboardIndex from "./DashboardIndex";

export default async function Page() {
  const page = await renderPage("/dashboard", {});
  return (
    <InertiaShell page={page}>
      <DashboardIndex />
    </InertiaShell>
  );
}
