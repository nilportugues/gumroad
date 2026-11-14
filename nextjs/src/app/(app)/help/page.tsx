// HelpCenter::ArticlesController#index at /help (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import HelpCenterIndex from "./HelpCenterIndex";

export default async function Page() {
  const page = await renderPage("/help", {});

  return (
    <InertiaShell page={page}>
      <HelpCenterIndex />
    </InertiaShell>
  );
}
