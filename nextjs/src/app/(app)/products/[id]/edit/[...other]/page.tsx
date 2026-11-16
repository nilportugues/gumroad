// LinksController#edit for the editor's tabs (/products/:id/edit/content, /receipt, /share): the same action.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import ProductsEdit from "../ProductsEdit";

export default async function Page({ params }: { params: Promise<{ id: string; other: string[] }> }) {
  const { id, other } = await params;
  const page = await renderPage("/products/:id/edit/*other", { id, other: other.join("/") });
  return (
    <InertiaShell page={page}>
      <ProductsEdit />
    </InertiaShell>
  );
}
