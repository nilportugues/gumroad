// LinksController#cart_items_count as the Inertia frame (props in server/page-props/product-pages.ts); its JSON answer is a mutation.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import ProductsCartItemsCount from "./ProductsCartItemsCount";

export default async function Page() {
  const page = await renderPage("/cart_items_count", {});
  return (
    <InertiaShell page={page}>
      <ProductsCartItemsCount />
    </InertiaShell>
  );
}
