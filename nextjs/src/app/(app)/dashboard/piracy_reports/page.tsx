// PiracyReportsController#index (props in server/page-props/piracy-reports/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import PiracyReportsIndex from "./PiracyReportsIndex";

export default async function Page() {
  const page = await renderPage("/dashboard/piracy_reports", {});

  return (
    <InertiaShell page={page}>
      <PiracyReportsIndex />
    </InertiaShell>
  );
}
