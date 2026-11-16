// WorkflowsController#index (props in server/page-props/audience/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import WorkflowsIndex from "./WorkflowsIndex";

export default async function Page() {
  const page = await renderPage("/workflows", {});
  return (
    <InertiaShell page={page}>
      <WorkflowsIndex />
    </InertiaShell>
  );
}
