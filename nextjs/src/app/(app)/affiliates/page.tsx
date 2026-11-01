// Affiliates/Index (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import AffiliatesIndex from "./AffiliatesIndex";

export default async function Page() {
  const page = await renderPage("/affiliates", {});

  return (
    <InertiaShell page={page}>
      <AffiliatesIndex />
    </InertiaShell>
  );
}
