// CustomersController#show (props in server/page-props/customers/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

import CustomersShow from "./CustomersShow";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const page = await renderPage("/customers/sale/:purchase_id", { purchase_id });
  return (
    <InertiaShell page={page}>
      <CustomersShow />
    </InertiaShell>
  );
}
