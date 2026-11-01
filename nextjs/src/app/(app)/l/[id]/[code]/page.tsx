// LinksController#show with an offer code in the path, on the Gumroad domain.
import ProductsShow from "@/app/(app)/l/ProductsShow";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page({ params }: { params: Promise<{ id: string; code: string }> }) {
  const { id, code } = await params;
  const page = await renderPage("/l/:id/:code", { id, code });

  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <ProductsShow />
    </InertiaShell>
  );
}
