// PublicController#widgets (props in server/page-props/public-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import PublicWidgets from "./WidgetsPage";

export default async function Page() {
  const page = await renderPage("/widgets", {});

  return (
    <InertiaShell page={page}>
      <PublicWidgets />
    </InertiaShell>
  );
}
