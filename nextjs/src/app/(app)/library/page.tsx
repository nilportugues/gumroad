// LibraryController#index (props in server/page-props/buyer/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import LibraryIndex from "./LibraryIndex";

export default async function Page() {
  const page = await renderPage("/library", {});

  return (
    <InertiaShell page={page}>
      <LibraryIndex />
    </InertiaShell>
  );
}
