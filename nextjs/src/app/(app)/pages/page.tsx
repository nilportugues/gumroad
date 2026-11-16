// PagesController#index (props in server/page-props/seller-pages.ts). New and edit are served to
// Inertia visits only: their editor (rich text, uploads) cannot be rendered by Next.js yet.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../_shell/InertiaShell";
import PagesIndex from "./PagesIndex";

export default async function Page() {
  const page = await renderPage("/pages", {});

  return (
    <InertiaShell page={page}>
      <PagesIndex />
    </InertiaShell>
  );
}
