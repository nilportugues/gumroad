// Purchases::ProductController#show (props in server/page-props/buyer/purchase-product.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import PurchasesProductShow from "./PurchasesProductShow";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const page = await renderPage("/purchases/:purchase_id/product", { purchase_id });

  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <PurchasesProductShow />
    </InertiaShell>
  );
}
