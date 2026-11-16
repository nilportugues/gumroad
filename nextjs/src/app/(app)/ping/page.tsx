// PublicController#ping (props in server/page-props/public-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import PublicPing from "./PingPage";

export default async function Page() {
  const page = await renderPage("/ping", {});

  return (
    <InertiaShell page={page}>
      <PublicPing />
    </InertiaShell>
  );
}
