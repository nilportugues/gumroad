// TaxCenter/Index (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import TaxCenterIndex from "./TaxCenterIndex";

export default async function Page() {
  const page = await renderPage("/payouts/taxes", {});

  return (
    <InertiaShell page={page}>
      <TaxCenterIndex />
    </InertiaShell>
  );
}
