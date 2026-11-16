// DiscoverController#index for a taxonomy path (`/*taxonomy`). The proxy only sends a path that is a taxonomy's
// here (DiscoverTaxonomyConstraint); props in server/page-props/discover/.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import DiscoverIndex from "../discover/DiscoverIndex";

export default async function Page({ params }: { params: Promise<{ taxonomy: string[] }> }) {
  const { taxonomy } = await params;
  const page = await renderPage("/*taxonomy", { taxonomy: taxonomy.join("/") });
  return (
    <InertiaShell page={page} layout="loggedInUser" clientOnly>
      <DiscoverIndex />
    </InertiaShell>
  );
}
