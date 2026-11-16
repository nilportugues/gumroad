// HelpCenter::ArticlesController#show (props in server/page-props/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import HelpCenterArticle from "./HelpCenterArticle";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await renderPage("/help/article/:slug", { slug });

  return (
    <InertiaShell page={page}>
      <HelpCenterArticle />
    </InertiaShell>
  );
}
