// Products::ArchivedController#index (props in server/page-props/seller-products/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ProductsArchivedIndex from "./ProductsArchivedIndex";

export default async function Page() {
  const page = await renderPage("/products/archived", {});
  return (
    <InertiaShell page={page}>
      <ProductsArchivedIndex />
    </InertiaShell>
  );
}
