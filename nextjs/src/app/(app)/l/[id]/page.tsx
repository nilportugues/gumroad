// LinksController#show on the Gumroad domain, for a seller without a username (otherwise it is a redirect).
import ProductsShow from "@/app/(app)/l/ProductsShow";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/l/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <ProductsShow />
    </InertiaShell>
  );
}
