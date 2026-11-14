// AudienceController#index (props in server/page-props/analytics/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import AudienceIndex from "./AudienceIndex";

export default async function Page() {
  const page = await renderPage("/dashboard/audience", {});
  return (
    <InertiaShell page={page}>
      <AudienceIndex />
    </InertiaShell>
  );
}
