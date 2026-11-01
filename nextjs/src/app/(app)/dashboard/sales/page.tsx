// AnalyticsController#index (props in server/page-props/analytics/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import AnalyticsIndex from "./AnalyticsIndex";

export default async function Page() {
  const page = await renderPage("/dashboard/sales", {});
  return (
    <InertiaShell page={page}>
      <AnalyticsIndex />
    </InertiaShell>
  );
}
