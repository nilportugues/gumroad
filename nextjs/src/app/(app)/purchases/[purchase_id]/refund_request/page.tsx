// Purchases::RefundRequestsController#show (props in server/page-props/buyer/refund-request-page.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

import RefundRequestShow from "./RefundRequestShow";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const page = await renderPage("/purchases/:purchase_id/refund_request", { purchase_id });

  return (
    <InertiaShell page={page} layout="public">
      <RefundRequestShow />
    </InertiaShell>
  );
}
