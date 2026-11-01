// Payouts/Index (props in server/page-props/payouts/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import PayoutsIndex from "./PayoutsIndex";

export default async function Page() {
  const page = await renderPage("/payouts", {});

  return (
    <InertiaShell page={page}>
      <PayoutsIndex />
    </InertiaShell>
  );
}
