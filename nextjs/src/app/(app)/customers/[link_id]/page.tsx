// CustomersController#index for one product (props in server/page-props/customers/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import CustomersIndex from "../CustomersIndex";

export default async function Page({ params }: { params: Promise<{ link_id: string }> }) {
  const { link_id } = await params;
  const page = await renderPage("/customers/:link_id", { link_id });
  return (
    <InertiaShell page={page}>
      <CustomersIndex />
    </InertiaShell>
  );
}
