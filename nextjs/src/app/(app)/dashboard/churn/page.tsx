// ChurnController#show (props in server/page-props/analytics/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ChurnShow from "./ChurnShow";

export default async function Page() {
  const page = await renderPage("/dashboard/churn", {});
  return (
    <InertiaShell page={page}>
      <ChurnShow />
    </InertiaShell>
  );
}
