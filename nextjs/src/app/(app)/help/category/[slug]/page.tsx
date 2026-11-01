// HelpCenter::CategoriesController#show (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import HelpCenterCategory from "./HelpCenterCategory";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await renderPage("/help/category/:slug", { slug });

  return (
    <InertiaShell page={page}>
      <HelpCenterCategory />
    </InertiaShell>
  );
}
