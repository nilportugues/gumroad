// Oauth::ApplicationsController#edit (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import EditApplication from "./EditApplication";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/oauth/applications/:id/edit", { id });

  return (
    <InertiaShell page={page}>
      <EditApplication />
    </InertiaShell>
  );
}
