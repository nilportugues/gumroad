// LinksController#show on a product's own domain.
import ProductsShow from "@/app/(app)/l/ProductsShow";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("product:/l/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <ProductsShow />
    </InertiaShell>
  );
}
