// Checkout/Show (props in server/page-props/checkout/). Carts and URLs the port cannot prove go to Rails.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import CheckoutShow from "./CheckoutShow";

export default async function Page() {
  const page = await renderPage("/checkout", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <CheckoutShow />
    </InertiaShell>
  );
}
