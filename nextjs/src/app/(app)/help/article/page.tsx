// HelpCenter::ArticlesController#index at /help/article (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import HelpCenterIndex from "../HelpCenterIndex";

export default async function Page() {
  const page = await renderPage("/help/article", {});

  return (
    <InertiaShell page={page}>
      <HelpCenterIndex />
    </InertiaShell>
  );
}
