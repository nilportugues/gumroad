// Products::CollabsController#index (props in server/page-props/seller-products/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ProductsCollabsIndex from "./ProductsCollabsIndex";

export default async function Page() {
  const page = await renderPage("/products/collabs", {});
  return (
    <InertiaShell page={page}>
      <ProductsCollabsIndex />
    </InertiaShell>
  );
}
