// GumroadBlog::PostsController#show (props in server/page-props/storefront/post-pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";
import ShowPage from "./BlogPostShow";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await renderPage("/blog/p/:slug", { slug });

  return (
    <InertiaShell page={page} layout="loggedInUser">
      <ShowPage />
    </InertiaShell>
  );
}
