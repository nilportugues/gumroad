// WorkflowsController#edit (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import WorkflowsEdit from "./WorkflowsEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/workflows/:id/edit", { id });
  return (
    <InertiaShell page={page}>
      <WorkflowsEdit />
    </InertiaShell>
  );
}
