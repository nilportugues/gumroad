// UtmLinksController#new (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import UtmLinksNew from "./UtmLinksNew";

export default async function Page() {
  const page = await renderPage("/dashboard/utm_links/new", {});
  return (
    <InertiaShell page={page}>
      <UtmLinksNew />
    </InertiaShell>
  );
}
