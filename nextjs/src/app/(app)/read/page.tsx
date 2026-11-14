// LibraryController#index, reached at /read (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import LibraryIndex from "../library/LibraryIndex";

export default async function Page() {
  const page = await renderPage("/read", {});

  return (
    <InertiaShell page={page}>
      <LibraryIndex />
    </InertiaShell>
  );
}
