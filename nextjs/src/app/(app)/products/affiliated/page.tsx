// Products::AffiliatedController#index (props in server/page-props/seller-products/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import ProductsAffiliatedIndex from "./ProductsAffiliatedIndex";

export default async function Page() {
  const page = await renderPage("/products/affiliated", {});
  return (
    <InertiaShell page={page}>
      <ProductsAffiliatedIndex />
    </InertiaShell>
  );
}
