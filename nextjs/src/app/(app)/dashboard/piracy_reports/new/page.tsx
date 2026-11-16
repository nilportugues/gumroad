// PiracyReportsController#new (props in server/page-props/piracy-reports/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import PiracyReportsNew from "./PiracyReportsNew";

export default async function Page() {
  const page = await renderPage("/dashboard/piracy_reports/new", {});

  return (
    <InertiaShell page={page}>
      <PiracyReportsNew />
    </InertiaShell>
  );
}
