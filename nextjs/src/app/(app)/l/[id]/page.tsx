// LinksController#show on the Gumroad domain, for a seller without a username (otherwise it is a redirect).
import ProductsPage from "@/app/(app)/l/ProductsPage";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/l/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <ProductsPage component={page.component} />
    </InertiaShell>
  );
}
