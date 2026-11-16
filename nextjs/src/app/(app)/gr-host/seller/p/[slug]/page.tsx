// PostsController#show on a seller subdomain or custom domain (props in server/page-props/storefront/post-pages.ts).
// The proxy rewrites `/p/:slug` here for those hosts only (/gr-host/seller/...).
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import PostsShow from "./PostsShow";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await renderPage("seller:/p/:slug", { slug });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <PostsShow />
    </InertiaShell>
  );
}
