// Collaborators/Index (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import CollaboratorsIndex from "./CollaboratorsIndex";

export default async function Page() {
  const page = await renderPage("/collaborators", {});

  return (
    <InertiaShell page={page}>
      <CollaboratorsIndex />
    </InertiaShell>
  );
}
