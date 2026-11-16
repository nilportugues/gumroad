// Bundles::ContentController#edit (props in server/page-props/bundles/edit.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";

import BundlesContentEdit from "./BundlesContentEdit";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/bundles/:bundle_id/content/edit", { bundle_id: id });
  return (
    <InertiaShell page={page}>
      <BundlesContentEdit />
    </InertiaShell>
  );
}
