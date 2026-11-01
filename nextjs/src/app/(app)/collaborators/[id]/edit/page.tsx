// Collaborators/Edit (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import CollaboratorsEdit from "./CollaboratorsEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const page = await renderPage("/collaborators/:id/edit", { id });

  return (
    <InertiaShell page={page}>
      <CollaboratorsEdit />
    </InertiaShell>
  );
}
