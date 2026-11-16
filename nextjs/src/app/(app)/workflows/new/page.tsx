// WorkflowsController#new (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import WorkflowsNew from "./WorkflowsNew";

export default async function Page() {
  const page = await renderPage("/workflows/new", {});
  return (
    <InertiaShell page={page}>
      <WorkflowsNew />
    </InertiaShell>
  );
}
