// LinksController#edit (props in server/page-props/seller-products/edit.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import ProductsEdit from "./ProductsEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/products/:id/edit", { id });
  return (
    <InertiaShell page={page}>
      <ProductsEdit />
    </InertiaShell>
  );
}
