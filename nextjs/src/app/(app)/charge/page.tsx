// PublicController#charge (props in server/page-props/public-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import Charge from "./ChargePage";

export default async function Page() {
  const page = await renderPage("/charge", {});

  return (
    <InertiaShell page={page}>
      <Charge />
    </InertiaShell>
  );
}
