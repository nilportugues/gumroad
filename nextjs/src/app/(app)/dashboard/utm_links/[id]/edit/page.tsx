// UtmLinksController#edit (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import UtmLinksEdit from "./UtmLinksEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/dashboard/utm_links/:id/edit", { id });
  return (
    <InertiaShell page={page}>
      <UtmLinksEdit />
    </InertiaShell>
  );
}
