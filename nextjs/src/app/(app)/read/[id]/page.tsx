// UrlRedirectsController#read (props in server/page-props/url-redirects/read-page.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../_shell/InertiaShell";
import UrlRedirectsRead from "./UrlRedirectsRead";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await renderPage("/read/:id", { id });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <UrlRedirectsRead />
    </InertiaShell>
  );
}
