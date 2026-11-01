// Oauth::ApplicationsController#edit (props in server/page-props/settings/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import EditApplication from "./EditApplication";

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The external id ends in "==": the router hands it over percent-encoded.
  const page = await renderPage("/oauth/applications/:id/edit", { id: decodeSegment(id) });

  return (
    <InertiaShell page={page}>
      <EditApplication />
    </InertiaShell>
  );
}
