// Collaborators/New (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import CollaboratorsNew from "./CollaboratorsNew";

export default async function Page() {
  const page = await renderPage("/collaborators/new", {});

  return (
    <InertiaShell page={page}>
      <CollaboratorsNew />
    </InertiaShell>
  );
}
