// LinksController#index (props in server/page-props/seller-products/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import ProductsIndex from "./ProductsIndex";

export default async function Page() {
  const page = await renderPage("/products", {});
  return (
    <InertiaShell page={page}>
      <ProductsIndex />
    </InertiaShell>
  );
}
