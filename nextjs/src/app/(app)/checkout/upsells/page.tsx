// Checkout::UpsellsController#index (props in server/page-props/checkout-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import UpsellsIndex from "./UpsellsIndex";

export default async function Page() {
  const page = await renderPage("/checkout/upsells", {});
  return (
    <InertiaShell page={page}>
      <UpsellsIndex />
    </InertiaShell>
  );
}
