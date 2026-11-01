// PostsController#show on the Gumroad domain (rules in server/page-props/posts.ts). The proxy answers
// every request for this route itself, because Rails always redirects it to the seller's host or
// 404s, so this page only runs if a visitor reaches Next.js without going through the proxy.
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../_shell/InertiaShell";

export default async function Page({ params }: { params: Promise<{ username: string; slug: string }> }) {
  const { username, slug } = await params;
  const page = await renderPage("/:username/p/:slug", { username, slug });

  return <InertiaShell page={page} layout="loggedInUser">{null}</InertiaShell>;
}
