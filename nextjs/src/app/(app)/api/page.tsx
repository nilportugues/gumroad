// PublicController#api (props in server/page-props/public-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import Api from "./ApiPage";

export default async function Page() {
  const page = await renderPage("/api", {});

  return (
    <InertiaShell page={page}>
      <Api />
    </InertiaShell>
  );
}
