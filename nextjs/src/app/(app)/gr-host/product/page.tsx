// LinksController#show at the root of a product's own domain.
import ProductsPage from "@/app/(app)/l/ProductsPage";
import { InertiaShell } from "@/app/(app)/_shell/InertiaShell";
import { renderPage } from "@/server/page-props/render-page";

export default async function Page() {
  const page = await renderPage("product:/", {});

  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <ProductsPage component={page.component} />
    </InertiaShell>
  );
}
