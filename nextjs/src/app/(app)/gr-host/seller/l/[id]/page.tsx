// LinksController#show on a seller subdomain or custom domain (props in presenters/product-page.ts).
import ProductsShow from "@/app/(app)/l/ProductsShow";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("seller:/l/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <ProductsShow />
    </InertiaShell>
  );
}
