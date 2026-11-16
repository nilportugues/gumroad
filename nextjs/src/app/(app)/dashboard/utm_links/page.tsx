// UtmLinksController#index (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import UtmLinksIndex from "./UtmLinksIndex";

export default async function Page() {
  const page = await renderPage("/dashboard/utm_links", {});
  return (
    <InertiaShell page={page}>
      <UtmLinksIndex />
    </InertiaShell>
  );
}
