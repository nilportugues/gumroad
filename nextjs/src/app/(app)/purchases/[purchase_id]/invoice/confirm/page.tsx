// Purchases::InvoicesController#confirm (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import InvoicesConfirm from "./InvoicesConfirm";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const page = await renderPage("/purchases/:purchase_id/invoice/confirm", { purchase_id });

  return (
    <InertiaShell page={page} layout="public">
      <InvoicesConfirm />
    </InertiaShell>
  );
}
