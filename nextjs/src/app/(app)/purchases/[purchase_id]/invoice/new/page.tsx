// Purchases::InvoicesController#new (props in server/page-props/buyer/invoice-form.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";

import InvoicesNew from "./InvoicesNew";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const page = await renderPage("/purchases/:purchase_id/invoice/new", { purchase_id });

  return (
    <InertiaShell page={page} layout="public" clientOnly>
      <InvoicesNew />
    </InertiaShell>
  );
}
