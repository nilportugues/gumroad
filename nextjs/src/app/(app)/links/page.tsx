// LinksController#index through `resources :links` (GET /links), the same page as /products
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import ProductsIndex from "../products/ProductsIndex";

export default async function Page() {
  const page = await renderPage("/links", {});
  return (
    <InertiaShell page={page}>
      <ProductsIndex />
    </InertiaShell>
  );
}
