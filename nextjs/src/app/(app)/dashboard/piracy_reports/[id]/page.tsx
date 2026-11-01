// PiracyReportsController#show (props in server/page-props/piracy-reports/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import PiracyReportsShow from "./PiracyReportsShow";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idDecoded = decodeURIComponent(id);
  const page = await renderPage("/dashboard/piracy_reports/:id", { id: idDecoded });

  return (
    <InertiaShell page={page}>
      <PiracyReportsShow />
    </InertiaShell>
  );
}
