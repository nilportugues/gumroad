// GumroadBlog::PostsController#show: not ported (server/page-props/gumroad-blog.ts throws NotPortedError).
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await renderPage("/blog/p/:slug", { slug });

  return <InertiaShell page={page} layout="loggedInUser">{null}</InertiaShell>;
}
