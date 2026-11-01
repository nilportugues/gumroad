// Affiliates/Onboarding (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import AffiliatesOnboarding from "./AffiliatesOnboarding";

export default async function Page() {
  const page = await renderPage("/affiliates/onboarding", {});

  return (
    <InertiaShell page={page}>
      <AffiliatesOnboarding />
    </InertiaShell>
  );
}
