// Checkout::DiscountsController#index (props in server/page-props/checkout-discounts-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import DiscountsIndex from "./DiscountsIndex";

export default async function Page() {
  const page = await renderPage("/checkout/discounts", {});
  return (
    <InertiaShell page={page}>
      <DiscountsIndex />
    </InertiaShell>
  );
}
