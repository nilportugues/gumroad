// Checkout::FormController#show (props in server/page-props/checkout-form/).
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";

import CheckoutFormShow from "./CheckoutFormShow";

export default async function Page() {
  const page = await renderPage("/checkout/form", {});

  return (
    <InertiaShell page={page}>
      <CheckoutFormShow />
    </InertiaShell>
  );
}
