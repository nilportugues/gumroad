// LinksController#show at the root of a product's own domain.
import ProductsShow from "@/app/(app)/l/ProductsShow";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page() {
  const page = await renderPage("product:/", {});

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <ProductsShow />
    </InertiaShell>
  );
}
