// LinksController#new (props in server/page-props/seller-products/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ProductsNew from "./ProductsNew";

export default async function Page() {
  const page = await renderPage("/products/new", {});
  return (
    <InertiaShell page={page}>
      <ProductsNew />
    </InertiaShell>
  );
}
