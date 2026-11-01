// Workflows::EmailsController#index (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import WorkflowEmailsIndex from "./WorkflowEmailsIndex";

// Next.js wants one slug name per dynamic segment, and `[id]` is the edit page's.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/workflows/:workflow_id/emails", { workflow_id: id });
  return (
    <InertiaShell page={page}>
      <WorkflowEmailsIndex />
    </InertiaShell>
  );
}
