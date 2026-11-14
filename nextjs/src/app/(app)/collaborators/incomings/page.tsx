// Collaborators/Incomings/Index (props in server/page-props/dashboard-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";

import CollaboratorsIncomings from "./CollaboratorsIncomings";

export default async function Page() {
  const page = await renderPage("/collaborators/incomings", {});

  return (
    <InertiaShell page={page}>
      <CollaboratorsIncomings />
    </InertiaShell>
  );
}
