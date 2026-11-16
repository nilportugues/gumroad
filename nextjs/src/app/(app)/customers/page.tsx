// CustomersController#index (props in server/page-props/customers/)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import CustomersIndex from "./CustomersIndex";

export default async function Page() {
  const page = await renderPage("/customers", {});
  return (
    <InertiaShell page={page}>
      <CustomersIndex />
    </InertiaShell>
  );
}
