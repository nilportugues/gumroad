// LibraryController#index (library_purchase) (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import LibraryIndex from "../../LibraryIndex";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/library/purchase/:id", { id });

  return (
    <InertiaShell page={page}>
      <LibraryIndex />
    </InertiaShell>
  );
}
