// Affiliates/New (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import AffiliatesNew from "./AffiliatesNew";

export default async function Page() {
  const page = await renderPage("/affiliates/new", {});

  return (
    <InertiaShell page={page}>
      <AffiliatesNew />
    </InertiaShell>
  );
}
